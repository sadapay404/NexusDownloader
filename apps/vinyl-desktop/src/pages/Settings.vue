<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { useSettingStore } from "@/stores/setting";
import { useI18n } from "vue-i18n";
import { localeEntries } from "@/locales";
import { getVersion } from "@tauri-apps/api/app";

const { t } = useI18n();
const settingStore = useSettingStore();
const appVersion = ref("");

const platform = ref("");
const platformLabel = computed(() => {
  const map: Record<string, string> = {
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
  };
  return map[platform.value] || platform.value;
});

const localeOptions = localeEntries.map((e) => ({ label: `${e.flag} ${e.label}`, value: e.code }));

const themeModeOptions = computed(() => [
  { label: t("settings.themeAuto"), value: "auto" },
  { label: t("settings.themeLight"), value: "light" },
  { label: t("settings.themeDark"), value: "dark" },
]);

const concurrentFragmentsOptions = computed(() => [
  { label: t("settings.disabled"), value: 0 },
  { label: "2", value: 2 },
  { label: "4", value: 4 },
  { label: "8", value: 8 },
  { label: "16", value: 16 },
]);

const maxConcurrentOptions = computed(() =>
  Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), value: i + 1 })),
);

const notifyModeOptions = computed(() => [
  { label: t("settings.noNotification"), value: "none" },
  { label: t("settings.inApp"), value: "app" },
  { label: t("settings.systemNotification"), value: "system" },
  { label: t("settings.all"), value: "all" },
]);

const downloadModeOptions = computed(() => [
  { label: t("common.default"), value: "default" },
  { label: t("detail.videoOnly"), value: "video" },
  { label: t("detail.audioOnly"), value: "audio" },
]);

onMounted(async () => {
  platform.value = await invoke<string>("get_platform");
  appVersion.value = await getVersion();
});
</script>

<template>
  <div class="settings-page">
    <n-flex align="center" justify="space-between" style="margin-bottom: 20px">
      <n-h1 style="margin: 0">{{ $t("settings.title") }}</n-h1>
    </n-flex>

    <ToolManager />

    <n-card :title="$t('settings.youtubeAdvanced')" size="small" class="section-card">
      <n-flex vertical :size="12">
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.jsRuntime") }}</span>
            <n-select
              v-model:value="settingStore.jsRuntime"
              :aria-label="$t('settings.jsRuntime')"
              :options="[
                { label: 'Deno', value: 'deno' },
                { label: 'Node.js', value: 'node' },
                { label: 'Bun', value: 'bun' },
                { label: 'QuickJS', value: 'quickjs' },
              ]"
              size="small"
              style="width: 160px"
            />
          </div>
        </div>
        <n-text depth="3" style="font-size: 13px">{{ $t("settings.jsRuntimeHint") }}</n-text>
        <n-text depth="3" style="font-size: 13px">
          {{ $t("settings.youtubeAdvancedDesc") }}
        </n-text>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.youtubePoToken") }}</span>
            <n-input
              v-model:value="settingStore.youtubePoToken"
              :input-props="{ 'aria-label': $t('settings.youtubePoToken') }"
              :placeholder="$t('settings.youtubePoTokenPlaceholder')"
              size="small"
              clearable
              style="flex: 1; max-width: 480px"
            />
          </div>
          <div class="info-row">
            <span class="info-label">{{ $t("settings.youtubeVisitorData") }}</span>
            <n-input
              v-model:value="settingStore.youtubeVisitorData"
              :input-props="{ 'aria-label': $t('settings.youtubeVisitorData') }"
              :placeholder="$t('settings.youtubeVisitorDataPlaceholder')"
              size="small"
              clearable
              style="flex: 1; max-width: 480px"
            />
          </div>
        </div>
      </n-flex>
    </n-card>

    <n-card :title="$t('settings.appearance')" size="small" class="section-card">
      <div class="info-list">
        <div class="info-row">
          <span class="info-label">{{ $t("settings.language") }}</span>
          <select v-model="settingStore.locale" class="language-select" :aria-label="$t('settings.language')">
            <option v-for="option in localeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <div class="info-row">
          <span class="info-label">{{ $t("settings.themeMode") }}</span>
          <n-select
            v-model:value="settingStore.themeMode"
            :aria-label="$t('settings.themeMode')"
            :options="themeModeOptions"
            style="width: 120px"
            size="small"
          />
        </div>
        <div class="info-row">
          <span class="info-label">{{ $t("settings.showTrayIcon") }}</span>
          <n-switch v-model:value="settingStore.showTrayIcon" :aria-label="$t('settings.showTrayIcon')" />
        </div>
        <div class="info-row">
          <span class="info-label">{{ $t("settings.closeToTray") }}</span>
          <n-switch
            v-model:value="settingStore.closeToTray" :aria-label="$t('settings.closeToTray')"
            :disabled="!settingStore.showTrayIcon"
          />
        </div>
      </div>
    </n-card>

    <n-card :title="$t('settings.personalization')" size="small" class="section-card">
      <div class="info-list">
        <div class="info-row">
          <span class="info-label">{{ $t("settings.startMaximized") }}</span>
          <n-switch v-model:value="settingStore.startMaximized" :aria-label="$t('settings.startMaximized')" />
        </div>
        <div class="info-row">
          <span class="info-label">{{ $t("settings.showHomeTips") }}</span>
          <n-switch v-model:value="settingStore.showHomeTips" :aria-label="$t('settings.showHomeTips')" />
        </div>
        <div class="info-row">
          <span class="info-label">{{ $t("settings.showTaskbarProgress") }}</span>
          <n-switch v-model:value="settingStore.showTaskbarProgress" :aria-label="$t('settings.showTaskbarProgress')" />
        </div>
      </div>
    </n-card>

    <CookieCard class="section-card" />

    <DownloadDirCard class="section-card" />

    <ProxyCard class="section-card" />

    <n-card :title="$t('settings.downloadOptions')" size="small" class="section-card">
      <n-flex vertical :size="12">
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.playlistSubfolders") }}</span>
            <n-switch v-model:value="settingStore.playlistSubfolders" :aria-label="$t('settings.playlistSubfolders')" />
          </div>
        </div>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("detail.downloadMethod") }}</span>
            <n-select
              v-model:value="settingStore.defaultDownloadMode"
              :aria-label="$t('detail.downloadMethod')"
              :options="downloadModeOptions"
              size="small"
              style="width: 160px"
            />
          </div>
        </div>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.concurrentFragments") }}</span>
            <n-select
              v-model:value="settingStore.concurrentFragments"
              :aria-label="$t('settings.concurrentFragments')"
              :options="concurrentFragmentsOptions"
              size="small"
              style="width: 120px"
            />
          </div>
        </div>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.maxConcurrentDownloads") }}</span>
            <n-select
              v-model:value="settingStore.maxConcurrentDownloads"
              :aria-label="$t('settings.maxConcurrentDownloads')"
              :options="maxConcurrentOptions"
              size="small"
              style="width: 120px"
            />
          </div>
        </div>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.downloadNotification") }}</span>
            <n-select
              v-model:value="settingStore.notifyMode"
              :aria-label="$t('settings.downloadNotification')"
              :options="notifyModeOptions"
              size="small"
              style="width: 120px"
            />
          </div>
        </div>
        <n-text depth="3">{{ $t("settings.keepBoth") }}</n-text>
        <div class="info-list">
          <div class="info-row">
            <n-tooltip placement="right" :style="{ maxWidth: '320px' }">
              <template #trigger>
                <span class="info-label">{{ $t("settings.defaultFfmpegArgs") }}</span>
              </template>
              {{ $t("settings.defaultFfmpegArgsHint") }}
            </n-tooltip>
            <n-input
              v-model:value="settingStore.defaultFfmpegArgs"
              :input-props="{ 'aria-label': $t('settings.defaultFfmpegArgs') }"
              :placeholder="$t('detail.ffmpegArgsPlaceholder')"
              size="small"
              clearable
              style="width: min(480px, 64vw)"
            />
          </div>
        </div>
      </n-flex>
    </n-card>

    <n-card :title="$t('detail.customArgs')" size="small" class="section-card">
      <n-input
        v-model:value="settingStore.defaultCustomArgs"
        :input-props="{ 'aria-label': $t('detail.customArgs') }"
        :placeholder="$t('detail.customArgsPlaceholder')"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
      />
    </n-card>

    <n-card :title="$t('settings.about')" size="small" class="section-card">
      <n-flex vertical :size="8">
        <n-text depth="3" style="font-size: 13px">
          NexusDownloader · {{ $t("vinyl.basedOn") }}
        </n-text>
        <n-text depth="3" style="font-size: 13px">
          {{ $t("vinyl.appUpdates") }}
        </n-text>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">{{ $t("settings.version") }}</span>
            <n-text code>v{{ appVersion }}</n-text>
          </div>
          <div class="info-row">
            <span class="info-label">{{ $t("settings.platform") }}</span>
            <n-text code>{{ platformLabel }}</n-text>
          </div>
          <div class="info-row">
            <span class="info-label">{{ $t("settings.license") }}</span>
            <n-text code>MIT</n-text>
          </div>
          <div class="info-row">
            <span class="info-label">{{ $t("settings.repository") }}</span>
            <n-button
              text
              tag="a"
              href="https://github.com/sadapay404/NexusDownloader"
              rel="noopener noreferrer"
              target="_blank"
              size="tiny"
            >
              GitHub
            </n-button>
          </div>
          <div class="info-row">
            <span class="info-label">{{ $t("settings.upstreamRepository") }}</span>
            <n-button
              tag="a"
              text
              size="tiny"
              target="_blank"
              rel="noopener noreferrer"
              href="https://github.com/imsyy/yt-dlp-gui"
            >
              imsyy/yt-dlp-gui
            </n-button>
          </div>
        </div>
      </n-flex>
    </n-card>
  </div>
</template>

<style scoped lang="scss">
.settings-page {
  height: 100%;
  overflow-y: auto;
  padding: 16px;
  max-width: 100%;
}

.section-card {
  margin-bottom: 12px;
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  align-items: center;
  font-size: 13px;
  min-height: 28px;

  &::before {
    order: 1;
    content: "";
    flex: 1;
    border-bottom: 1px dashed var(--n-border-color, #e0e0e6);
    margin: 0 8px;
    min-width: 20px;
  }

  > :last-child {
    order: 2;
    flex-shrink: 0;
  }
}

.language-select {
  width: 120px;
  padding: 5px 8px;
  border: 1px solid var(--n-border-color);
  border-radius: 4px;
  background-color: var(--n-color);
  color: inherit;
  font: inherit;
}

.language-select:focus-visible {
  outline: 2px solid var(--vinyl-accent);
  outline-offset: 2px;
}

.info-label {
  flex-shrink: 0;
  order: 0;
}
</style>
