import { invoke } from "@tauri-apps/api/core";
import { useSettingStore } from "@/stores/setting";

interface ToolSettingsLifecycle {
  pauseQueue: () => void;
  resumeQueue: () => void;
}

// Older profiles may have persisted null for an optional text field.
const optionalText = (value: unknown): string => typeof value === "string" ? value : "";

export const useAppBootstrap = ({ pauseQueue, resumeQueue }: ToolSettingsLifecycle) => {
  const settings = useSettingStore();
  const toolSettingsFailed = ref(false);
  const applyingToolSettings = ref(false);
  let generation = 0;
  let pending = Promise.resolve();

  function applyToolSettings(): Promise<void> {
    const version = ++generation;
    const sources = {
      ytdlp: settings.ytdlpSource,
      deno: settings.denoSource,
      ffmpeg: settings.ffmpegSource,
      ytdlpLocalPath: optionalText(settings.ytdlpLocalPath),
    };
    const runtime = settings.jsRuntime;
    const channel = settings.ytdlpChannel;
    const extractor = {
      poToken: optionalText(settings.youtubePoToken),
      visitorData: optionalText(settings.youtubeVisitorData),
    };
    applyingToolSettings.value = true;
    pauseQueue();

    // Serialize updates: a slow older request must not overwrite newer settings
    // or start a waiting download with a partially applied configuration.
    pending = pending.then(async () => {
      if (version !== generation) return;
      try {
        await invoke("set_tool_sources", sources);
        await invoke("set_js_runtime", { runtime });
        await invoke("set_ytdlp_channel", { channel });
        await invoke("set_youtube_extractor_args", extractor);
        if (version !== generation) return;
        toolSettingsFailed.value = false;
        resumeQueue();
      } catch (error) {
        if (version !== generation) return;
        console.error("Could not apply desktop tool settings:", error);
        toolSettingsFailed.value = true;
      } finally {
        if (version === generation) applyingToolSettings.value = false;
      }
    });
    return pending;
  }

  watch(() => [
    settings.ytdlpSource, settings.ytdlpLocalPath, settings.denoSource, settings.ffmpegSource,
    settings.jsRuntime, settings.ytdlpChannel, settings.youtubePoToken, settings.youtubeVisitorData,
  ], () => void applyToolSettings());

  return { applyToolSettings, toolSettingsFailed, applyingToolSettings };
};
