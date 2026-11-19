import { invoke } from "@tauri-apps/api/core";
import { useSettingStore } from "@/stores/setting";

/**
 * 封装应用启动引导与底层服务同步逻辑的 Composable：
 * 1. CLI 工具源设置同步（managed / system / custom）
 * 2. yt-dlp 分支通道同步（stable / nightly / master）
 *
 * @returns 包含启动方法与各个同步操作的对象
 */
export const useAppBootstrap = () => {
  const settingStore = useSettingStore();

  /**
   * 将前端持久化的 CLI 工具源同步至 Rust 后端
   *
   * @returns Promise<unknown>
   */
  const applyToolSources = (): Promise<unknown> =>
    invoke("set_tool_sources", {
      ytdlp: settingStore.ytdlpSource,
      deno: settingStore.denoSource,
      ffmpeg: settingStore.ffmpegSource,
      ytdlpLocalPath: settingStore.ytdlpLocalPath,
    });

  /**
   * 将前端配置的 yt-dlp 分支通道同步至 Rust 后端
   *
   * @returns Promise<unknown>
   */
  const applyYtdlpChannel = (): Promise<unknown> =>
    invoke("set_ytdlp_channel", { channel: settingStore.ytdlpChannel }).catch(() => {});

  /**
   * 执行完整的应用启动引导任务
   *
   * @returns Promise<void>
   */
  const bootstrap = async (): Promise<void> => {
    watch(
      () => [
        settingStore.ytdlpSource,
        settingStore.ytdlpLocalPath,
        settingStore.denoSource,
        settingStore.ffmpegSource,
      ],
      () => applyToolSources(),
    );

    watch(
      () => settingStore.ytdlpChannel,
      () => applyYtdlpChannel(),
    );

    await applyToolSources();
    watch(
      () => settingStore.jsRuntime,
      (runtime) => invoke("set_js_runtime", { runtime }),
    );
    await invoke("set_js_runtime", { runtime: settingStore.jsRuntime });
    await applyYtdlpChannel();
  };

  return {
    bootstrap,
    applyToolSources,
    applyYtdlpChannel,
  };
};
