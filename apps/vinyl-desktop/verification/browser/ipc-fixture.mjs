// Explicit test-only Tauri IPC fixture; no commands here are shipped to desktop users.
export const shareUrl = "https://youtu.be/dQw4w9WgXcQ";
export const shortsUrl = "https://www.youtube.com/shorts/dQw4w9WgXcQ";
export const watchUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
export const directory = "C:/Users/fixture/Downloads";
export const title = "A Vinyl Study";

export async function installIpcFixture(page, options = {}) {
  await page.addInitScript(
    ({ settings, source, info, folder, fetchFailure, ffmpegReady, runtimeReady, ytdlpReady, initialTasks, unavailable, toolSettingsError }) => {
      const callbacks = new Map();
      const listeners = new Map();
      const calls = [];
      let handle = 0;
      const tool = {
        installed: true,
        runnable: true,
        path: "test.exe",
        version: "test",
        source: "managed",
      };
      const tasksKey = "verification-rows";
      const readTasks = () => JSON.parse(localStorage.getItem(tasksKey) || "[]");
      const writeTasks = (rows) => localStorage.setItem(tasksKey, JSON.stringify(rows));
      if (!localStorage.getItem(tasksKey)) writeTasks(initialTasks);
      window.vinylFixture = {
        calls,
        clipboard: source,
        focused: true,
        ytdlpReady,
        info,
        fetchFailure,
        cancelError: null,
        rejectWrites: false,
        toolSettingsError,
        emit(event, payload) {
          if (event.startsWith("download-") && payload.attempt === undefined) {
            payload = { ...payload, attempt: readTasks().find((row) => row.id === payload.id)?.createdAt };
          }
          for (const [id, listener] of listeners) {
            if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
          }
        },
      };
      Object.defineProperty(document, "hasFocus", { value: () => window.vinylFixture.focused });
      if (!localStorage.getItem("setting")) localStorage.setItem("setting", JSON.stringify(settings));
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback(cb, once) {
          const id = ++handle;
          callbacks.set(id, (value) => {
            if (once) callbacks.delete(id);
            cb(value);
          });
          return id;
        },
        unregisterCallback(id) {
          callbacks.delete(id);
        },
        async invoke(cmd, args) {
          calls.push({ cmd, args });
          if (cmd === "plugin:event|listen") {
            const id = ++handle;
            listeners.set(id, args);
            return id;
          }
          if (cmd === "plugin:event|unlisten") {
            listeners.delete(args.eventId);
            return;
          }
          if (cmd === "plugin:clipboard-manager|read_text") return window.vinylFixture.clipboard;
          if (cmd === "fetch_video_info") {
            if (!window.vinylFixture.ytdlpReady) throw "err_ytdlp_not_installed";
            if (window.vinylFixture.fetchFailure) throw window.vinylFixture.fetchFailure;
            return window.vinylFixture.info;
          }
          if (cmd === "set_youtube_extractor_args") {
            if (window.vinylFixture.toolSettingsError) throw window.vinylFixture.toolSettingsError;
            if (typeof args.poToken !== "string" || typeof args.visitorData !== "string") {
              throw "invalid args for set_youtube_extractor_args";
            }
          }
          if (cmd === "db_get_tasks") return readTasks().sort((a, b) => b.createdAt - a.createdAt);
          if (cmd === "db_upsert_task") {
            if (window.vinylFixture.rejectWrites) throw "fixture write error";
            writeTasks([...readTasks().filter((row) => row.id !== args.task.id), args.task]);
          }
          if (cmd === "db_delete_task") writeTasks(readTasks().filter((row) => row.id !== args.id));
          if (cmd === "db_delete_tasks") writeTasks(readTasks().filter((row) => !args.ids.includes(row.id)));
          if (cmd === "cancel_download" && window.vinylFixture.cancelError) {
            throw window.vinylFixture.cancelError;
          }
          if (cmd === "get_platform") return "windows";
          if (cmd === "plugin:app|version") return "0.2.1";
          if (cmd === "plugin:dialog|open") return folder;
          if (cmd === "get_ytdlp_status") {
            const ready = window.vinylFixture.ytdlpReady;
            return { ...tool, installed: ready, runnable: ready };
          }
          if (cmd === "get_deno_status") return tool;
          if (cmd === "download_ytdlp") { window.vinylFixture.ytdlpReady = true; return null; }
          if (cmd === "get_ffmpeg_status")
            return { ...tool, installed: ffmpegReady, runnable: ffmpegReady };
          if (cmd === "get_js_runtime_status") return { ...tool, runnable: runtimeReady };
          if (cmd === "check_files_exist") return args.paths.map((path) => !unavailable.includes(path));
          if (
            cmd === "db_get_history" ||
            cmd === "take_browser_extension_imports" ||
            cmd === "tool_get_running_tasks" ||
            cmd === "channel_sync_active" ||
            cmd === "channel_enrich_active"
          )
            return [];
          return null;
        },
      };
    },
    {
      settings: {
        locale: "en-US",
        downloadDir: options.directory ?? directory,
        notifyMode: "none",
        ...options.settings,
      },
      source: options.clipboard ?? "",
      info: options.info ?? videoInfo(options),
      folder: directory,
      fetchFailure: options.fetchFailure ?? null,
      ffmpegReady: options.ffmpegReady ?? true,
      runtimeReady: options.runtimeReady ?? true,
      ytdlpReady: options.ytdlpReady ?? true,
      initialTasks: options.initialTasks ?? [],
      unavailable: options.unavailable ?? [],
      toolSettingsError: options.toolSettingsError ?? null,
    },
  );
}

export function videoInfo({ top = 2160, portrait = false } = {}) {
  return {
    title,
    duration: 143,
    thumbnail: "/vinyl.webp",
    uploader: "Fixture Channel",
    formats: [2160, 1440, 1080, 720, 480, 360, 240, 144]
      .filter((tier) => tier <= top)
      .map((tier) => {
        const other = Math.ceil((tier * 16) / (9 * 2)) * 2;
        return {
          format_id: `v-${tier}`,
          height: portrait ? other : tier,
          width: portrait ? tier : other,
          vcodec: "avc1.64002a",
          acodec: "none",
          ext: "mp4",
          fps: 30,
          filesize: tier * 1024,
        };
      })
      .concat({ format_id: "a-140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", abr: 128 }),
  };
}

export const requests = (page, command) =>
  page.evaluate(
    (cmd) => window.vinylFixture.calls.filter((call) => call.cmd === cmd).map((call) => call.args),
    command,
  );
