import { defineStore } from "pinia";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { DownloadTask, DownloadTaskParams } from "@/types";
import { useSettingStore } from "@/stores/setting";
import { formatFileSize } from "@/utils/format";
import { cleanMultipleTasksResiduals } from "@/utils/taskFiles";
import { normalizeTaskParams } from "@/utils/taskParams";
import { pushTaskLog, trimTaskLogs } from "@/utils/logs";
import i18n from "@/locales";

interface AttemptEvent {
  id: string;
  attempt: number;
}

interface ProgressPayload extends AttemptEvent {
  percent: number;
  speed: string;
  eta: string;
  downloaded: string;
  total: string;
  status?: string;
}

const isRunning = (task: DownloadTask) =>
  task.status === "downloading" || task.status === "postprocessing";
const isInterruptible = (task: DownloadTask) =>
  isRunning(task) || task.status === "queued" || task.status === "preparing";
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useDownloadStore = defineStore("download", () => {
  const settings = useSettingStore();
  // Newest first for history. The scheduler reads the opposite end of the list.
  const tasks = ref<DownloadTask[]>([]);
  const loaded = ref(false);
  const unavailableOutputs = reactive(new Set<string>());
  const enqueuing = new Map<string, { createdAt: number; written: Promise<boolean> }>();
  const deleting = new Set<string>();
  const pendingWrites = new Map<string, Promise<boolean>>();
  const startingTasks = new Map<string, Promise<unknown>>();
  const startingIds = reactive(new Set<string>());
  const cancellingIds = reactive(new Set<string>());
  const cancellations = new Map<string, Promise<boolean>>();
  let scheduling: Promise<void> | undefined;
  let scheduleRequested = false;
  let queueEnabled = false;
  let lastCreatedAt = 0;

  const find = (id: string) => tasks.value.find((task) => task.id === id);
  const activeCount = computed(() =>
    new Set([...startingIds, ...tasks.value.filter(isRunning).map((task) => task.id)]).size,
  );
  const nextCreatedAt = () => (lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1));

  async function loadTasks(): Promise<void> {
    try {
      const rows = await invoke<DownloadTask[]>("db_get_tasks");
      tasks.value = rows.map((row) => {
        lastCreatedAt = Math.max(lastCreatedAt, row.createdAt);
        const live = find(row.id);
        if (live && (isRunning(live) || enqueuing.has(live.id))) return live;
        if (Array.isArray(row.logs)) trimTaskLogs(row.logs);
        else row.logs = [];
        return row;
      });
    } catch (error) {
      console.error("Unable to load download history:", error);
    } finally {
      loaded.value = true;
    }
    void refreshOutputAvailability();
    if (queueEnabled) void tryStartNext();
  }

  async function refreshOutputAvailability() {
    const completed = tasks.value.filter((task) => task.status === "completed" && task.outputFile);
    if (!completed.length) return;
    try {
      const exists = await invoke<boolean[]>("check_files_exist", {
        paths: completed.map((task) => task.outputFile!),
      });
      completed.forEach((task, index) => {
        if (find(task.id) === task && typeof exists[index] === "boolean") {
          markOutputAvailable(task.id, exists[index]);
        }
      });
    } catch (error) {
      console.warn("Unable to check saved files:", error);
    }
  }

  function markOutputAvailable(id: string, available: boolean) {
    if (available) unavailableOutputs.delete(id);
    else unavailableOutputs.add(id);
  }

  // Per-row ordering prevents a late queued snapshot reviving a cancelled task.
  async function persistTask(task: DownloadTask): Promise<boolean> {
    const record = {
      ...task,
      logs: [...task.logs],
      params: normalizeTaskParams({ ...task.params, subtitles: [...(task.params?.subtitles ?? [])] }),
    };
    const previous = pendingWrites.get(task.id);
    const writing = (async () => {
      if (previous) await previous;
      try {
        await invoke("db_upsert_task", { task: record });
        return true;
      } catch (error) {
        console.error("Unable to save download history:", error);
        return false;
      }
    })();
    pendingWrites.set(task.id, writing);
    try {
      return await writing;
    } finally {
      if (pendingWrites.get(task.id) === writing) pendingWrites.delete(task.id);
    }
  }

  const updateTask = async (task: DownloadTask) => {
    const current = find(task.id);
    if (!current) return false;
    Object.assign(current, task);
    return persistTask(current);
  };

  async function tryStartNext(): Promise<void> {
    if (!queueEnabled) return;
    scheduleRequested = true;
    if (scheduling) return scheduling;
    scheduling = (async () => {
      await ready;
      do {
        scheduleRequested = false;
        while (activeCount.value < settings.maxConcurrent) {
          let next: DownloadTask | undefined;
          for (let i = tasks.value.length - 1; i >= 0; i--) {
            if (tasks.value[i].status === "queued") { next = tasks.value[i]; break; }
          }
          // Do not overtake an earlier queued row whose write/cancel is still in flight.
          if (!next || cancellations.has(next.id) || deleting.has(next.id) ||
              [...enqueuing.values()].some((write) => write.createdAt <= next!.createdAt)) break;
          const { id } = next;
          next.params = normalizeTaskParams(next.params);
          next.status = "downloading";
          startingIds.add(id);
          const starting = invoke("start_download", { params: { ...next.params, id } });
          startingTasks.set(id, starting);
          try {
            await starting;
          } catch (error) {
            if (find(id) === next && isRunning(next)) {
              next.status = "error";
              next.error = describe(error);
              next.speed = "";
              next.eta = "";
              await updateTask(next);
            }
          } finally {
            startingTasks.delete(id);
            startingIds.delete(id);
          }
        }
      } while (scheduleRequested);
    })().finally(() => {
      scheduling = undefined;
      if (scheduleRequested) void tryStartNext();
    });
    return scheduling;
  }

  /** App bootstrap calls this after persisted tool sources and runtime have been applied. */
  function enableQueue() {
    queueEnabled = true;
    return tryStartNext();
  }

  async function notifyComplete(task: DownloadTask) {
    const { notifyMode } = settings;
    if (notifyMode === "none") return;
    const title = i18n.global.t("downloads.notifyComplete");
    const body = task.title || i18n.global.t("downloads.notifyCompleteBody");
    if (notifyMode === "app" || notifyMode === "all") {
      window.$notification.create({ title, content: body, duration: 5000 });
    }
    if (notifyMode === "system" || notifyMode === "all") {
      if ((await isPermissionGranted()) || (await requestPermission()) === "granted") {
        sendNotification({ title, body });
      }
    }
  }

  function updateTaskbarProgress() {
    const running = settings.showTaskbarProgress ? tasks.value.filter(isRunning) : [];
    const progress = running.length
      ? Math.round(running.reduce((sum, task) => sum + (task.percent || 0), 0) / running.length)
      : 0;
    void getCurrentWindow().setProgressBar({
      status: running.length ? ProgressBarStatus.Normal : ProgressBarStatus.None,
      progress,
    });
  }

  function settle(task: DownloadTask, status: DownloadTask["status"], error?: string) {
    task.status = status;
    task.error = error;
    task.speed = "";
    task.eta = "";
  }

  function finish(task: DownloadTask) {
    // Native completion is already committed; this preserves renderer diagnostics.
    void updateTask(task);
    updateTaskbarProgress();
    void tryStartNext();
  }

  function currentAttempt({ id, attempt }: AttemptEvent): DownloadTask | undefined {
    const task = find(id);
    return task && task.createdAt === attempt && isRunning(task) ? task : undefined;
  }

  async function setupListeners() {
    await listen<ProgressPayload>("download-progress", ({ payload }) => {
      const task = currentAttempt(payload);
      if (!task) return;
      if (payload.status === "postprocessing") {
        task.status = "postprocessing";
        task.speed = "";
        task.eta = "";
        if (payload.percent > 0) task.percent = payload.percent;
      } else {
        task.status = "downloading";
        task.percent = payload.percent;
        task.speed = payload.speed;
        task.eta = payload.eta;
      }
      if (payload.downloaded) task.downloaded = payload.downloaded;
      if (payload.total) task.total = payload.total;
      updateTaskbarProgress();
    });
    await listen<AttemptEvent & { line: string }>("download-log", ({ payload }) => {
      const task = currentAttempt(payload);
      if (task) pushTaskLog(task.logs, payload.line);
    });
    await listen<AttemptEvent & { outputFile: string; fileSizeBytes: number }>(
      "download-complete",
      ({ payload }) => {
        const task = currentAttempt(payload);
        if (!task) return;
        if (!payload.outputFile?.trim() || !Number.isFinite(payload.fileSizeBytes) || payload.fileSizeBytes <= 0) {
          settle(task, "error", "err_download_no_output");
        } else {
          settle(task, "completed");
          task.percent = 100;
          task.outputFile = payload.outputFile;
          task.fileSizeBytes = payload.fileSizeBytes;
          task.total = formatFileSize(payload.fileSizeBytes);
          markOutputAvailable(task.id, true);
          void notifyComplete(task).catch((error) => console.warn("Notification failed:", error));
        }
        finish(task);
      },
    );
    await listen<AttemptEvent & { error: string }>("download-error", ({ payload }) => {
      const task = currentAttempt(payload);
      if (!task) return;
      settle(task, "error", payload.error);
      finish(task);
    });
    await listen<AttemptEvent>("download-cancelled", ({ payload }) => {
      const task = currentAttempt(payload);
      if (!task) return;
      settle(task, "cancelled");
      finish(task);
    });
  }

  const ready = Promise.all([loadTasks(), setupListeners()]);
  watch(() => settings.maxConcurrent, () => void tryStartNext());

  async function addTask(
    task: DownloadTask,
    preparingTaskId?: string,
  ): Promise<"started" | "queued" | "failed" | "preparing"> {
    await ready;
    const id = preparingTaskId ?? task.id;
    const preparing = preparingTaskId ? find(preparingTaskId) : undefined;
    if (enqueuing.has(id) || deleting.has(id) || cancellations.has(id) ||
        (preparingTaskId ? preparing?.status !== "preparing" : Boolean(find(id)))) return "failed";
    const record: DownloadTask = {
      ...task, id, createdAt: nextCreatedAt(),
      status: task.status === "preparing" ? "preparing" : "queued",
    };
    if (!preparing) tasks.value.unshift(record);
    const target = find(id)!;
    if (!(await enqueueWrite(record, () => {
      if (preparing) {
        Object.assign(target, record);
        moveToFront(target);
      }
    }))) {
      if (!preparing) settle(target, "error", "err_download_history_write");
      void tryStartNext();
      return "failed";
    }
    await tryStartNext();
    return target.status === "queued" || target.status === "preparing"
      ? target.status
      : target.status === "error" || target.status === "cancelled" ? "failed" : "started";
  }

  function enqueueWrite(record: DownloadTask, apply: () => void): Promise<boolean> {
    const written = persistTask(record).then((saved) => {
      if (saved) apply();
      return saved;
    }).finally(() => enqueuing.delete(record.id));
    enqueuing.set(record.id, { createdAt: record.createdAt, written });
    return written;
  }

  function moveToFront(task: DownloadTask) {
    tasks.value = [task, ...tasks.value.filter((candidate) => candidate.id !== task.id)]
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function cancelTask(id: string): Promise<boolean> {
    const existing = cancellations.get(id);
    if (existing) return existing;
    const task = find(id);
    if (!task || (!isInterruptible(task) && !enqueuing.has(id))) return Promise.resolve(true);

    cancellingIds.add(id);
    const cancelling = (async () => {
      await enqueuing.get(id)?.written;
      await pendingWrites.get(id);
      await startingTasks.get(id)?.catch(() => {});
      if (!isInterruptible(task)) return true;
      if (isRunning(task)) {
        try {
          // The worker waits for its whole process tree and persists the result.
          await invoke("cancel_download", { id });
        } catch (error) {
          if (!isRunning(task)) return task.status === "cancelled";
          throw error; // Still active; retain its slot and let the user try again.
        }
        if (!isRunning(task)) return task.status === "cancelled";
        settle(task, "cancelled");
        finish(task);
      } else {
        const cancelled = { ...task };
        settle(cancelled, "cancelled");
        if (!(await persistTask(cancelled))) throw new Error("err_download_history_write");
        Object.assign(task, cancelled);
      }
      return true;
    })().finally(() => {
      cancellations.delete(id);
      cancellingIds.delete(id);
      void tryStartNext();
    });
    cancellations.set(id, cancelling);
    return cancelling;
  }

  async function retryTask(id: string, editedParams?: DownloadTaskParams): Promise<boolean> {
    const task = find(id);
    if (!task || !["error", "cancelled"].includes(task.status) || task.params.downloadMode === "preparation" ||
        enqueuing.has(id) || deleting.has(id) || cancellations.has(id)) return false;
    const params = normalizeTaskParams(editedParams ?? task.params);
    const replacement: DownloadTask = {
      ...task, params, status: "queued", createdAt: nextCreatedAt(), percent: 0,
      speed: "", eta: "", downloaded: "", total: "", logs: [], error: undefined,
      outputFile: undefined, fileSizeBytes: undefined,
      formatLabel: editedParams ? i18n.global.t(
        params.downloadMode === "audio" ? "detail.audioOnly" : params.downloadMode === "video" ? "detail.videoOnly" : "detail.defaultQuality",
      ) : task.formatLabel,
    };
    // A single atomic SQLite upsert replaces the row; neither the previous
    // diagnostics nor the in-memory task change if persistence fails.
    const saved = await enqueueWrite(replacement, () => {
      Object.assign(task, replacement);
      moveToFront(task);
    });
    if (!saved) { void tryStartNext(); return false; }
    await tryStartNext();
    return task.status !== "error" && task.status !== "cancelled";
  }

  async function reDownloadTask(id: string): Promise<void> {
    const task = find(id);
    if (!task || task.status !== "completed") return;
    const result = await addTask({
      ...task, id: `dl_${crypto.randomUUID()}`, status: "queued", percent: 0,
      speed: "", eta: "", downloaded: "", total: "", logs: [], error: undefined,
      outputFile: undefined, fileSizeBytes: undefined,
    });
    if (result === "failed") throw new Error(i18n.global.t("downloads.startFailed"));
  }

  async function retryAllInterrupted() {
    const ids = tasks.value.filter((task) => ["error", "cancelled"].includes(task.status)).map((task) => task.id).reverse();
    for (const id of ids) await retryTask(id);
  }

  async function removeTask(id: string): Promise<boolean> {
    if (deleting.has(id)) return false;
    deleting.add(id);
    try {
      await cancelTask(id);
      await pendingWrites.get(id);
      await invoke("db_delete_task", { id });
      unavailableOutputs.delete(id);
      tasks.value = tasks.value.filter((task) => task.id !== id);
      return true;
    } finally {
      deleting.delete(id);
      void tryStartNext();
    }
  }

  async function clearTasks(statuses: DownloadTask["status"][], cleanResiduals: boolean) {
    const targets = tasks.value.filter((task) => statuses.includes(task.status) &&
      !enqueuing.has(task.id) && !deleting.has(task.id) && !cancellations.has(task.id));
    const ids = targets.map((task) => task.id);
    if (!ids.length) return;
    ids.forEach((id) => deleting.add(id));
    try {
      await Promise.all(ids.map((id) => pendingWrites.get(id)));
      await invoke("db_delete_tasks", { ids });
      const removed = new Set(ids);
      tasks.value = tasks.value.filter((task) => !removed.has(task.id));
      ids.forEach((id) => unavailableOutputs.delete(id));
      if (cleanResiduals) await cleanMultipleTasksResiduals(targets);
    } finally {
      ids.forEach((id) => deleting.delete(id));
    }
  }

  return {
    tasks, loaded, activeCount, unavailableOutputs, markOutputAvailable, cancellingIds,
    loadTasks, enableQueue, addTask, updateTask, cancelTask, retryTask, reDownloadTask,
    retryAllInterrupted, removeTask,
    clearCompleted: () => clearTasks(["completed"], false),
    clearCancelled: () => clearTasks(["cancelled"], true),
    clearFailed: () => clearTasks(["error"], true),
    clearInterrupted: () => clearTasks(["error", "cancelled"], true),
  };
});
