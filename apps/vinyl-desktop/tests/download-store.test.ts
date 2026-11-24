import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { useDownloadStore } from "@/stores/download";
import { normalizeTaskParams } from "@/utils/taskParams";
import { MAX_TASK_LOGS } from "@/utils/logs";
import type { DownloadTask } from "@/types";

const { handlers, mockState } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
  mockState: {
    settings: { notifyMode: "none", showTaskbarProgress: false, maxConcurrent: 3 },
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event, handler) => {
    handlers.set(event, handler);
    return vi.fn();
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setProgressBar: vi.fn() }),
  ProgressBarStatus: { None: "none", Normal: "normal" },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("@/locales", () => ({ default: { global: { t: (key: string) => key } } }));
vi.mock("@/stores/setting", () => ({
  useSettingStore: () => mockState.settings,
}));

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  mockState.settings = reactive({
    notifyMode: "none",
    showTaskbarProgress: false,
    maxConcurrent: 3,
  });
  handlers.clear();
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "db_get_tasks" ? [] : undefined,
  );
});

afterEach(() => disposePinia(pinia));

const createTask = (id: string, status: DownloadTask["status"] = "queued"): DownloadTask => ({
  id,
  url: "https://example.com/video",
  title: "Video",
  thumbnail: "",
  formatLabel: "",
  status,
  percent: 0,
  speed: "",
  eta: "",
  downloaded: "",
  total: "",
  logs: [],
  createdAt: 0,
  params: normalizeTaskParams(),
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const readyStore = async (enable = true) => {
  const store = useDownloadStore();
  await vi.waitFor(() => {
    expect(store.loaded).toBe(true);
    expect(handlers.has("download-error")).toBe(true);
  });
  if (enable) await store.enableQueue();
  return store;
};

const starts = () =>
  vi.mocked(invoke).mock.calls.filter(([command]) => command === "start_download");

const complete = (id: string) =>
  handlers.get("download-complete")!({ payload: { id, attempt: useDownloadStore().tasks.find((task) => task.id === id)?.createdAt, outputFile: `${id}.mp4`, fileSizeBytes: 1024 } });

test("completed downloads retain and persist their bounded diagnostic logs", async () => {
  const store = useDownloadStore();
  await vi.waitFor(() => expect(handlers.has("download-complete")).toBe(true));
  store.tasks.push({
    id: "test",
    url: "https://example.com/video",
    title: "Video",
    thumbnail: "",
    formatLabel: "",
    status: "downloading",
    percent: 0,
    speed: "",
    eta: "",
    downloaded: "",
    total: "",
    logs: [],
    createdAt: 0,
    params: normalizeTaskParams(),
  });
  for (let index = 0; index < 600; index += 1) {
    handlers.get("download-log")!({ payload: { id: "test", attempt: 0, line: `line ${index}` } });
  }
  handlers.get("download-complete")!({ payload: { id: "test", attempt: 0, outputFile: "video.mp4", fileSizeBytes: 1024 } });
  const task = store.tasks[0];
  expect(task.status).toBe("completed");
  expect(task.logs).toHaveLength(MAX_TASK_LOGS);
  expect(task.logs[task.logs.length - 1]).toBe("line 599");
  expect(invoke).toHaveBeenCalledWith("db_upsert_task", { task: expect.objectContaining({ status: "completed", logs: task.logs }) });
});

test("restored queues fill every available slot and resume after a completion", async () => {
  mockState.settings.maxConcurrent = 2;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "db_get_tasks"
      ? [createTask("third"), createTask("second"), createTask("first")]
      : undefined,
  );
  const store = await readyStore();
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  expect(store.activeCount).toBe(2);
  expect(store.tasks.find((task) => task.id === "third")?.status).toBe("queued");

  complete("first");
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(store.activeCount).toBe(2);
});

test("a failed start keeps its diagnostics and does not stall the remaining queue", async () => {
  mockState.settings.maxConcurrent = 2;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "db_get_tasks") {
      return [createTask("third"), createTask("second"), createTask("broken")];
    }
    if (
      command === "start_download" &&
      (args as { params: { id: string } }).params.id === "broken"
    ) {
      throw new Error("cannot spawn yt-dlp");
    }
  });
  const store = await readyStore();
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(store.tasks.find((task) => task.id === "broken")).toMatchObject({ status: "error", error: "cannot spawn yt-dlp" });
  expect(store.activeCount).toBe(2);
  expect(invoke).toHaveBeenCalledWith(
    "db_upsert_task",
    expect.objectContaining({ task: expect.objectContaining({ id: "broken", status: "error" }) }),
  );
});

test("concurrent submissions start once each without exceeding the configured limit", async () => {
  mockState.settings.maxConcurrent = 2;
  const store = await readyStore();
  await Promise.all([
    store.addTask(createTask("one")),
    store.addTask(createTask("two")),
    store.addTask(createTask("three")),
  ]);
  expect(starts()).toHaveLength(2);
  expect(
    new Set(starts().map(([, args]) => (args as { params: { id: string } }).params.id)).size,
  ).toBe(2);
  expect(store.activeCount).toBe(2);
  expect(store.tasks.filter((task) => task.status === "queued")).toHaveLength(1);

  mockState.settings.maxConcurrent = 3;
  await vi.waitFor(() => expect(starts()).toHaveLength(3));
  expect(store.activeCount).toBe(3);
});

test("an unpersisted task cannot be picked up by another scheduling trigger", async () => {
  const store = await readyStore();
  const writing = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_upsert_task") await writing.promise;
  });
  const adding = store.addTask(createTask("pending"));
  await vi.waitFor(() => expect(store.tasks).toHaveLength(1));
  mockState.settings.maxConcurrent = 4;
  await nextTick();
  expect(starts()).toHaveLength(0);

  writing.resolve();
  expect(await adding).toBe("started");
  expect(starts()).toHaveLength(1);
});

test("a database failure prevents the task from starting", async () => {
  const store = await readyStore();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(invoke).mockRejectedValue(new Error("database unavailable"));
  expect(await store.addTask(createTask("unsaved"))).toBe("failed");
  expect(store.tasks[0].status).toBe("error");
  expect(starts()).toHaveLength(0);
  error.mockRestore();
});

test("cancelling during startup waits for the process and keeps its slot reserved", async () => {
  mockState.settings.maxConcurrent = 1;
  const store = await readyStore();
  const starting = deferred();
  const cancelling = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "start_download" && starts().length === 1) await starting.promise;
    if (command === "cancel_download") await cancelling.promise;
  });
  const addingFirst = store.addTask(createTask("first"));
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const cancelled = store.cancelTask("first");
  const addingSecond = store.addTask(createTask("second"));
  expect(invoke).not.toHaveBeenCalledWith("cancel_download", expect.anything());
  expect(store.activeCount).toBe(1);
  expect(store.tasks.find((task) => task.id === "first")?.status).toBe("downloading");

  starting.resolve();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("cancel_download", { id: "first" }),
  );
  expect(starts()).toHaveLength(1);
  expect(store.activeCount).toBe(1);
  cancelling.resolve();
  await cancelled;
  await Promise.all([addingFirst, addingSecond]);
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
  expect(store.tasks.find((task) => task.id === "first")?.status).toBe("cancelled");
});

test("a startup rejection retains the real error while a cancellation is waiting", async () => {
  const store = await readyStore();
  const starting = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "start_download") await starting.promise;
  });
  const adding = store.addTask(createTask("first"));
  await vi.waitFor(() => expect(starts()).toHaveLength(1));
  const cancelled = store.cancelTask("first");
  starting.reject(new Error("FFmpeg unavailable"));
  await Promise.all([adding, cancelled]);
  expect(store.tasks[0].status).toBe("error");
  expect(store.tasks[0].error).toBe("FFmpeg unavailable");
});

test("retries are deduplicated and cancellation during their persistence prevents startup", async () => {
  const store = await readyStore();
  store.tasks.push(createTask("failed", "error"));
  const saving = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_upsert_task") await saving.promise;
  });
  const retrying = store.retryTask("failed");
  expect(await store.retryTask("failed")).toBe(false);
  const cancelling = store.cancelTask("failed");
  expect(store.tasks[0].status).toBe("error");
  expect(invoke).not.toHaveBeenCalledWith("db_delete_task", expect.anything());
  saving.resolve();
  await Promise.all([retrying, cancelling]);
  expect(store.tasks).toHaveLength(1);
  expect(store.tasks[0].status).toBe("cancelled");
  expect(starts()).toHaveLength(0);
});

test("preparing replacements are kept out of the queue until their row is saved", async () => {
  const store = await readyStore();
  await store.addTask(createTask("preparing", "preparing"));
  const saving = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_upsert_task") await saving.promise;
  });
  const replacing = store.addTask(createTask("ready"), "preparing");
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("db_upsert_task", {
    task: expect.objectContaining({ id: "preparing", status: "queued" }),
  }));
  expect(store.tasks[0].status).toBe("preparing");
  mockState.settings.maxConcurrent = 4;
  await nextTick();
  expect(starts()).toHaveLength(0);
  saving.resolve();
  expect(await replacing).toBe("started");
  expect(store.tasks).toHaveLength(1);
  expect(starts()).toHaveLength(1);
});

test("removing a task waits for older writes and cannot recreate an orphaned row", async () => {
  const store = await readyStore();
  const writing = deferred();
  let saved = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_upsert_task" && !saved) {
      await writing.promise;
      saved = true;
    }
    if (command === "db_delete_task") expect(saved).toBe(true);
  });
  const adding = store.addTask(createTask("remove"));
  await vi.waitFor(() => expect(store.tasks).toHaveLength(1));
  const removing = store.removeTask("remove");
  writing.resolve();
  await Promise.all([adding, removing]);
  expect(store.tasks).toHaveLength(0);
  expect(starts()).toHaveLength(0);
  expect(invoke).toHaveBeenLastCalledWith("db_delete_task", { id: "remove" });
});

test("re-downloading preserves completed history and sends its clone through the queue", async () => {
  const store = await readyStore();
  store.tasks.push(createTask("history", "completed"));
  await store.reDownloadTask("history");
  expect(store.tasks).toHaveLength(2);
  expect(store.tasks.find((task) => task.id === "history")?.status).toBe("completed");
  expect(store.tasks[0].status).toBe("downloading");
  expect(starts()).toHaveLength(1);
});

test("clearing cancelled tasks does not remove an unconfirmed cancellation", async () => {
  const store = await readyStore();
  const stopping = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "cancel_download") await stopping.promise;
  });
  await store.addTask(createTask("clear"));
  const cancelling = store.cancelTask("clear");
  await store.clearCancelled();
  expect(store.tasks).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalledWith("db_delete_tasks", expect.anything());
  stopping.resolve();
  await cancelling;
  await store.clearCancelled();
  expect(invoke).toHaveBeenLastCalledWith("db_delete_tasks", { ids: ["clear"] });
});

test("clearing completed history waits for the final state to be persisted", async () => {
  const store = await readyStore();
  store.tasks.push(createTask("done", "downloading"));
  const writing = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_upsert_task") await writing.promise;
  });
  complete("done");
  const clearing = store.clearCompleted();
  expect(store.tasks).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalledWith("db_delete_tasks", expect.anything());
  writing.resolve();
  await clearing;
  expect(store.tasks).toHaveLength(0);
  expect(invoke).toHaveBeenLastCalledWith("db_delete_tasks", { ids: ["done"] });
});

test("edited retries persist the complete task configuration before starting", async () => {
  const store = await readyStore();
  const original = createTask("edit", "error");
  original.params = normalizeTaskParams({
    downloadDir: "D:/original",
    cookieFile: "D:/cookies.txt",
    cookieBrowser: "firefox",
    proxy: "http://old-proxy:8080",
    subtitles: ["sub:en", "auto:zh"],
    playlistItems: "2,5",
    noPlaylist: false,
    noOverwrites: true,
    embedMetadata: true,
  });
  store.tasks.push(original);
  const edited = {
    ...original.params,
    subtitles: [...original.params.subtitles],
    downloadMode: "audio",
    downloadDir: "D:/fixed",
    outputTemplate: "literal%% %(title)s.%(ext)s",
    startTime: 90000,
    endTime: 90100,
    customArgs: "--sleep-requests 2",
    noMerge: true,
  };
  const saving = deferred();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_upsert_task") await saving.promise;
  });
  const retrying = store.retryTask("edit", edited);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "db_upsert_task",
      expect.objectContaining({ task: expect.objectContaining({ params: edited }) }),
    ),
  );
  expect(starts()).toHaveLength(0);
  edited.subtitles.push("sub:fr");
  edited.downloadDir = "D:/changed-after-submit";
  saving.resolve();
  expect(await retrying).toBe(true);
  expect(store.tasks[0].formatLabel).toBe("detail.audioOnly");
  expect(invoke).toHaveBeenCalledWith("start_download", {
    params: expect.objectContaining({
      downloadDir: "D:/fixed",
      outputTemplate: "literal%% %(title)s.%(ext)s",
      cookieFile: "D:/cookies.txt",
      cookieBrowser: "firefox",
      proxy: "http://old-proxy:8080",
      subtitles: ["sub:en", "auto:zh"],
      playlistItems: "2,5",
      noPlaylist: false,
      noOverwrites: true,
      embedMetadata: true,
      startTime: 90000,
      endTime: 90100,
      customArgs: "--sleep-requests 2",
    }),
  });
});

test("edited retries cannot replace parameters of an active task", async () => {
  const store = await readyStore();
  store.tasks.push(createTask("active", "downloading"));
  const originalParams = { ...store.tasks[0].params };
  expect(await store.retryTask("active", normalizeTaskParams({ downloadMode: "audio" }))).toBe(
    false,
  );
  expect(store.tasks[0].params).toEqual(originalParams);
  expect(starts()).toHaveLength(0);
  expect(invoke).not.toHaveBeenCalledWith("db_delete_task", expect.anything());
});


test("a rejected cancellation leaves the task active and its slot occupied", async () => {
  const store = await readyStore();
  mockState.settings.maxConcurrent = 1;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "cancel_download") throw new Error("stop failed");
  });
  await store.addTask(createTask("active"));
  await store.addTask(createTask("waiting"));
  await expect(store.cancelTask("active")).rejects.toThrow("stop failed");
  expect(store.tasks.find((task) => task.id === "active")?.status).toBe("downloading");
  expect(store.activeCount).toBe(1);
  expect(starts()).toHaveLength(1);
  handlers.get("download-cancelled")!({ payload: { id: "active", attempt: store.tasks.find((task) => task.id === "active")?.createdAt } });
  await vi.waitFor(() => expect(starts()).toHaveLength(2));
});

test.each([{ outputFile: "", fileSizeBytes: 1 }, { outputFile: "no-file.mp4", fileSizeBytes: 0 }])(
  "no completion without a valid saved file payload (%j)", async (payload) => {
    const store = await readyStore();
    await store.addTask(createTask("active"));
    handlers.get("download-complete")!({ payload: { id: "active", attempt: store.tasks.find((task) => task.id === "active")?.createdAt, ...payload } });
    expect(store.tasks[0]).toMatchObject({ status: "error", error: "err_download_no_output" });
    expect(store.tasks[0].outputFile).toBeUndefined();
  },
);

test("a retry write failure does not change the previous durable row or its diagnostics", async () => {
  const original = { ...createTask("failed", "error"), error: "old details", logs: ["kept log"] };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_get_tasks") return [structuredClone(original)];
    if (command === "db_upsert_task") throw new Error("disk unavailable");
  });
  const store = await readyStore();
  expect(await store.retryTask("failed")).toBe(false);
  expect(store.tasks[0]).toEqual(original);
  await store.loadTasks();
  expect(store.tasks[0]).toEqual(original);
  expect(invoke).not.toHaveBeenCalledWith("db_delete_task", expect.anything());
  expect(starts()).toHaveLength(0);
});

test("restored rows wait for startup configuration and start oldest first", async () => {
  mockState.settings.maxConcurrent = 1;
  vi.mocked(invoke).mockImplementation(async (command) => command === "db_get_tasks"
    ? [createTask("C"), createTask("B"), createTask("A")] : undefined);
  const store = await readyStore(false);
  expect(starts()).toHaveLength(0);
  await store.enableQueue();
  const order = () => starts().map(([, args]) => (args as { params: { id: string } }).params.id);
  expect(order()).toEqual(["A"]);
  complete("A");
  await vi.waitFor(() => expect(order()).toEqual(["A", "B"]));
  complete("B");
  await vi.waitFor(() => expect(order()).toEqual(["A", "B", "C"]));
});

test("a temporarily unavailable destination never deletes completed history", async () => {
  const done = { ...createTask("offline", "completed"), outputFile: "X:/Saved/video.mp4" };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "db_get_tasks") return [done];
    if (command === "check_files_exist") return [false];
  });
  const store = await readyStore();
  expect(store.unavailableOutputs.has(done.id)).toBe(true);
  expect(store.tasks).toEqual([done]);
  expect(invoke).not.toHaveBeenCalledWith("db_delete_tasks", expect.anything());
});


test("a late terminal event cannot complete a newer attempt with the same ID", async () => {
  const store = await readyStore();
  await store.addTask(createTask("same"));
  const attempt = store.tasks[0].createdAt;
  handlers.get("download-error")!({ payload: { id: "same", attempt, error: "first failed" } });
  expect(await store.retryTask("same")).toBe(true);
  expect(store.tasks[0].createdAt).toBeGreaterThan(attempt);
  handlers.get("download-complete")!({ payload: { id: "same", attempt, outputFile: "old.mp4", fileSizeBytes: 1 } });
  expect(store.tasks[0].status).toBe("downloading");
  complete("same");
  expect(store.tasks[0].status).toBe("completed");
});
