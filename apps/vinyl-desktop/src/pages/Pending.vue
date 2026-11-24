<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { useStatusStore } from "@/stores/status";
import { showErrorDialog } from "@/utils/format";
import {
  clipboardVideo,
  consumeVinylSelection,
  formatForTier,
  nativeTier,
} from "@/utils/vinylSelection";
import { useVinylCountdown } from "@/composables/useVinylCountdown";
import { formatFileSize } from "@/utils/format";
import { estimateFileSize } from "@/utils/normalizer";
import { useVideoStore } from "@/stores/video";
import { useSettingStore } from "@/stores/setting";
import { usePendingStore } from "@/stores/pending";
import { useDownloadLauncher } from "@/composables/useDownloadLauncher";
import { useI18n } from "vue-i18n";
import type { ToolStatus, VideoInfo } from "@/types";

const { t } = useI18n();
const router = useRouter();
const videoStore = useVideoStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const pendingStore = usePendingStore();
const { launchDownload } = useDownloadLauncher();

const activeItem = computed(() => pendingStore.activeItem);

/**
 * 待下载页偏好型选项持久化
 */
const persistedOptionSnapshot = computed(() => {
  const item = activeItem.value;
  if (!item) return null;
  return {
    embedSubs: item.embedSubs,
    embedThumbnail: item.embedThumbnail,
    writeThumbnail: item.writeThumbnail,
    writeDescription: item.writeDescription,
    embedMetadata: item.embedMetadata,
    embedChapters: item.embedChapters,
    sponsorblockRemove: item.sponsorblockRemove,
    extractAudio: item.extractAudio,
    audioConvertFormat: item.audioConvertFormat,
    noMerge: item.noMerge,
    recodeFormat: item.recodeFormat,
    remuxFormat: item.remuxFormat,
    limitRate: item.limitRate,
    customArgs: item.customArgs,
  };
});

watch(persistedOptionSnapshot, (snapshot) => {
  if (!snapshot) return;
  settingStore.defaultEmbedSubs = snapshot.embedSubs;
  settingStore.defaultEmbedThumbnail = snapshot.embedThumbnail;
  settingStore.defaultWriteThumbnail = snapshot.writeThumbnail;
  settingStore.defaultWriteDescription = snapshot.writeDescription;
  settingStore.defaultEmbedMetadata = snapshot.embedMetadata;
  settingStore.defaultEmbedChapters = snapshot.embedChapters;
  settingStore.defaultSponsorblockRemove = snapshot.sponsorblockRemove;
  settingStore.defaultExtractAudio = snapshot.extractAudio;
  settingStore.defaultAudioConvertFormat = snapshot.audioConvertFormat;
  settingStore.defaultNoMerge = snapshot.noMerge;
  settingStore.defaultRecodeFormat = snapshot.recodeFormat;
  settingStore.defaultRemuxFormat = snapshot.remuxFormat;
  settingStore.defaultLimitRate = snapshot.limitRate;
  settingStore.defaultCustomArgs = snapshot.customArgs;
});

const estimatedSize = computed(() => {
  const item = activeItem.value;
  if (!item) return 0;
  let total = 0;
  const duration = item.videoInfo?.duration || 0;
  if (item.downloadMode !== "audio") {
    const vf = item.videoFormats.find((f) => f.format_id === item.selectedVideoFormat);
    if (vf) {
      const { size } = estimateFileSize(vf, duration);
      total += size;
    }
  }
  if (item.downloadMode !== "video") {
    const selectedAudio = item.selectedAudioFormat.split("+");
    for (const af of item.audioFormats.filter((f) => selectedAudio.includes(f.format_id))) {
      const { size } = estimateFileSize(af, duration);
      total += size;
    }
  }
  return total;
});

const estimatedSizeText = computed(() => {
  if (!estimatedSize.value) return t("common.unknown");
  return formatFileSize(estimatedSize.value);
});

const dirCardRef = ref<HTMLElement | null>(null);
const advancedRef = ref<HTMLElement | null>(null);
const deckRef = ref<HTMLElement | null>(null);
const expanded = ref(false);
const manual = ref(true);
const checking = ref(false);
const submitting = ref(false);
let revision = 0;

const showPresets = computed(() => {
  const item = activeItem.value;
  return (
    !!item &&
    !item.isPlaylist &&
    !item.videoInfo.is_live &&
    !["is_live", "is_upcoming"].includes(item.videoInfo.live_status || "") &&
    item.downloadMode !== "audio" &&
    !item.extractAudio &&
    item.videoFormats.length > 0
  );
});
const currentFormat = computed(() =>
  activeItem.value?.videoFormats.find(
    (format) => format.format_id === activeItem.value?.selectedVideoFormat,
  ),
);
const selectedTier = computed(() => nativeTier(currentFormat.value));
const offeredTiers = computed(
  () =>
    new Set(
      activeItem.value?.videoFormats
        .map(nativeTier)
        .filter((tier): tier is number => tier !== null),
    ),
);
const containsAudio = computed(() =>
  Boolean(currentFormat.value?.acodec && currentFormat.value.acodec !== "none"),
);
const mayContinue = computed(() => {
  const item = activeItem.value;
  return (
    showPresets.value &&
    !manual.value &&
    selectedTier.value === 1080 &&
    !!item &&
    item.downloadMode === "default" &&
    (containsAudio.value || Boolean(item.selectedAudioFormat)) &&
    !item.noMerge &&
    !item.customArgs.trim() &&
    !item.ffmpegArgs.trim() &&
    !submitting.value
  );
});
const hasSetupModal = computed(
  () =>
    statusStore.showYtdlpSetupModal ||
    statusStore.showDenoSetupModal ||
    statusStore.showFfmpegSetupModal ||
    statusStore.showCookieModal,
);

const { seconds, paused, start, stop } = useVinylCountdown(() => {
  if (
    mayContinue.value &&
    settingStore.downloadDir &&
    !hasSetupModal.value &&
    !videoStore.fetching
  ) {
    void handleDownload();
  } else cancelAuto();
});
function cancelAuto() {
  revision += 1;
  checking.value = false;
  manual.value = true;
  stop();
}

watch(
  () => activeItem.value?.id,
  (id) => {
    cancelAuto();
    expanded.value = false;
    const item = activeItem.value;
    if (!id || !consumeVinylSelection(id) || !item || !showPresets.value) return;
    const defaultFormat = formatForTier(
      item.videoFormats,
      1080,
      item.selectedVideoFormat,
      settingStore.preferredVideoCodec,
    );
    if (defaultFormat) {
      item.selectedVideoFormat = defaultFormat.format_id;
      manual.value = false;
    }
  },
  { immediate: true, flush: "sync" },
);

watch(
  [
    mayContinue,
    currentFormat,
    () => activeItem.value?.selectedAudioFormat,
    () => settingStore.downloadDir,
    () => videoStore.fetching,
    hasSetupModal,
  ],
  () => {
    if (seconds.value !== null || checking.value) cancelAuto();
  },
  { flush: "sync" },
);

function cancelOnExternalInteraction(event: PointerEvent) {
  if (
    (seconds.value !== null || checking.value) &&
    (!deckRef.value || !event.composedPath().includes(deckRef.value))
  )
    cancelAuto();
}
function cancelOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && (seconds.value !== null || checking.value)) cancelAuto();
}
onMounted(() => {
  document.addEventListener("pointerdown", cancelOnExternalInteraction, true);
  document.addEventListener("keydown", cancelOnEscape, true);
});
onUnmounted(() => {
  cancelAuto();
  document.removeEventListener("pointerdown", cancelOnExternalInteraction, true);
  document.removeEventListener("keydown", cancelOnEscape, true);
});
onBeforeRouteLeave(() => {
  cancelAuto();
});

function chooseTier(tier: number) {
  cancelAuto();
  const item = activeItem.value;
  if (!item || submitting.value) return;
  const format = formatForTier(
    item.videoFormats,
    tier,
    item.selectedVideoFormat,
    settingStore.preferredVideoCodec,
  );
  if (format) item.selectedVideoFormat = format.format_id;
}

function toggleMore() {
  cancelAuto();
  expanded.value = !expanded.value;
}

function showAdvanced() {
  cancelAuto();
  advancedRef.value?.focus({ preventScroll: true });
  advancedRef.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showDestination() {
  dirCardRef.value?.scrollIntoView({ behavior: "smooth", block: "center" });
  dirCardRef.value?.querySelector("button")?.focus({ preventScroll: true });
}

async function checkThenContinue() {
  const item = activeItem.value;
  if (
    !item ||
    !mayContinue.value ||
    checking.value ||
    seconds.value !== null ||
    hasSetupModal.value
  )
    return;
  if (!settingStore.downloadDir) {
    showDestination();
    return;
  }
  const attempt = ++revision;
  checking.value = true;
  const needsFfmpeg =
    !containsAudio.value ||
    Boolean(item.selectedAudioFormat) ||
    item.embedSubs ||
    item.embedThumbnail ||
    item.embedMetadata ||
    item.embedChapters ||
    item.sponsorblockRemove ||
    Boolean(item.recodeFormat || (item.remuxFormat && item.remuxFormat !== "auto")) ||
    item.startTime != null ||
    item.endTime != null;
  try {
    const [ytDlp, runtime, ffmpeg] = await Promise.all([
      invoke<ToolStatus>("get_ytdlp_status"),
      clipboardVideo(item.url) ? invoke<ToolStatus>("get_js_runtime_status") : undefined,
      needsFfmpeg ? invoke<ToolStatus>("get_ffmpeg_status") : undefined,
    ]);
    if (attempt !== revision || !mayContinue.value || !settingStore.downloadDir) return;
    const ready = (status: ToolStatus) => status.installed && status.runnable;
    if (!ready(ytDlp)) statusStore.showYtdlpSetupModal = true;
    else if (runtime && !ready(runtime) && settingStore.jsRuntime === "deno")
      statusStore.showDenoSetupModal = true;
    else if (ffmpeg && !ready(ffmpeg)) statusStore.showFfmpegSetupModal = true;
    if (!ready(ytDlp) || (runtime && !ready(runtime)) || (ffmpeg && !ready(ffmpeg))) {
      window.$message.warning(t("vinyl.toolsUnavailable"));
      return;
    }
    start();
  } catch {
    if (attempt === revision) window.$message.warning(t("vinyl.toolsUnavailable"));
  } finally {
    if (attempt === revision) checking.value = false;
  }
}

const tabLabel = (title: string): string => {
  if (!title) return t("detail.unknownVideo");
  if (title.length > 12) return title.slice(0, 10) + "…";
  return title;
};

const handleTabClose = (name: string | number) => {
  pendingStore.remove(String(name));
};

const handleTabAdd = () => {
  router.push({ name: "home" });
};

const handleBackToHome = () => {
  router.push({ name: "home" });
};

/** 重新获取当前项视频信息 */
const handleRefresh = async () => {
  cancelAuto();
  const item = activeItem.value;
  if (!item) return;
  const data = await videoStore.fetchVideoInfo(item.url, { customArgs: item.customArgs });
  if (data) {
    pendingStore.refresh(item.id, data);
    window.$message.success(t("detail.refreshSuccess"));
  }
};

/** 开始下载当前项 */
async function handleDownload() {
  const item = activeItem.value;
  if (!item || submitting.value) return;
  cancelAuto();
  submitting.value = true;
  try {
    const result = await launchDownload(item);
    if (result === "missing-directory") {
      showDestination();
    } else if (result === "started" || result === "queued") {
      pendingStore.remove(item.id);
      if (router.currentRoute.value.name === "pending") await router.push({ name: "downloads" });
    }
  } catch (error) {
    showErrorDialog(error instanceof Error ? error.message : String(error));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="pending-page">
    <template v-if="pendingStore.items.length > 0">
      <n-tabs
        v-model:value="pendingStore.activeId"
        type="card"
        size="small"
        closable
        addable
        class="tabs-bar"
        @close="handleTabClose"
        @add="handleTabAdd"
      >
        <template #prefix>
          <n-button size="small" strong secondary circle @click="handleBackToHome">
            <template #icon>
              <n-icon><icon-mdi-arrow-left /></n-icon>
            </template>
          </n-button>
        </template>
        <n-tab-pane
          v-for="item in pendingStore.items"
          :key="item.id"
          :name="item.id"
          :tab="tabLabel(item.videoInfo.title)"
          display-directive="show"
        />
      </n-tabs>

      <div
        v-if="activeItem"
        :key="activeItem.id"
        class="pending-content"
        :class="{ 'has-presets': showPresets }"
      >
        <n-flex :size="8" align="center" :wrap="false" style="margin-bottom: 16px">
          <n-input
            :value="activeItem.url"
            :placeholder="$t('detail.videoLink')"
            size="small"
            round
            readonly
            style="flex: 1; min-width: 0"
          />
          <n-button
            size="small"
            strong
            secondary
            round
            :loading="videoStore.fetching"
            @click="handleRefresh"
          >
            <template #icon>
              <n-icon><icon-mdi-refresh /></n-icon>
            </template>
          </n-button>
        </n-flex>

        <VideoInfoCard
          :video-info="activeItem.videoInfo as VideoInfo"
          :is-playlist="activeItem.isPlaylist"
          :playlist-count="activeItem.playlistEntries.length"
          class="section-card"
        />

        <div v-if="showPresets" ref="deckRef" class="section-card">
          <VinylQualityCard
            :offered="offeredTiers"
            :selected="selectedTier"
            :expanded="expanded"
            :automatic="mayContinue"
            :seconds="seconds"
            :paused="paused"
            :checking="checking"
            :submitting="submitting"
            :has-destination="Boolean(settingStore.downloadDir)"
            @choose="chooseTier"
            @more="toggleMore"
            @continue="checkThenContinue"
            @download="handleDownload"
            @cancel="cancelAuto"
            @advanced="showAdvanced"
          />
        </div>

        <div ref="dirCardRef" class="section-card">
          <DownloadDirCard />
        </div>

        <n-card
          v-if="activeItem.isPlaylist && activeItem.playlistEntries.length > 0"
          size="small"
          class="section-card"
        >
          <template #header>
            <n-flex align="center" :size="8">
              <n-icon size="16"><icon-mdi-playlist-play /></n-icon>
              <span>{{ $t("detail.playlist") }}</span>
              <n-tag size="small" round :bordered="false" type="info">
                {{ activeItem.selectedPlaylistItems.length }} /
                {{ activeItem.playlistEntries.length }}
              </n-tag>
            </n-flex>
          </template>
          <template #header-extra>
            <n-flex :size="8">
              <n-button
                size="tiny"
                secondary
                @click="
                  activeItem.selectedPlaylistItems = activeItem.playlistEntries.map(
                    (entry, i) => entry.playlist_index ?? i + 1,
                  )
                "
              >
                {{ $t("common.selectAll") }}
              </n-button>
              <n-button size="tiny" secondary @click="activeItem.selectedPlaylistItems = []">
                {{ $t("common.deselectAll") }}
              </n-button>
            </n-flex>
          </template>
          <n-checkbox-group v-model:value="activeItem.selectedPlaylistItems">
            <n-flex vertical :size="6">
              <n-checkbox
                v-for="(entry, index) in activeItem.playlistEntries"
                :key="entry.id"
                :value="entry.playlist_index ?? index + 1"
                :label="`P${entry.playlist_index ?? index + 1} ${entry.title}`"
              />
            </n-flex>
          </n-checkbox-group>
        </n-card>

        <div ref="advancedRef" tabindex="-1" class="advanced-options" @focusin="cancelAuto">
          <DownloadOptionsCard
            v-model:download-mode="activeItem.downloadMode"
            v-model:selected-video-format="activeItem.selectedVideoFormat"
            v-model:selected-audio-format="activeItem.selectedAudioFormat"
            :video-formats="activeItem.videoFormats"
            :extract-audio="activeItem.extractAudio"
            :audio-formats="activeItem.audioFormats"
            :video-info="activeItem.videoInfo as VideoInfo"
            class="section-card"
          />

          <SubtitleCard
            v-model:selected-subtitles="activeItem.selectedSubtitles"
            :video-info="activeItem.videoInfo as VideoInfo"
            class="section-card"
          />

          <ExtraOptionsCard
            v-model:start-time="activeItem.startTime"
            v-model:end-time="activeItem.endTime"
            v-model:force-keyframes-at-cuts="activeItem.forceKeyframesAtCuts"
            v-model:embed-subs="activeItem.embedSubs"
            v-model:embed-thumbnail="activeItem.embedThumbnail"
            v-model:write-thumbnail="activeItem.writeThumbnail"
            v-model:write-description="activeItem.writeDescription"
            v-model:embed-metadata="activeItem.embedMetadata"
            v-model:embed-chapters="activeItem.embedChapters"
            v-model:sponsorblock-remove="activeItem.sponsorblockRemove"
            v-model:extract-audio="activeItem.extractAudio"
            v-model:audio-convert-format="activeItem.audioConvertFormat"
            v-model:no-merge="activeItem.noMerge"
            v-model:recode-format="activeItem.recodeFormat"
            v-model:remux-format="activeItem.remuxFormat"
            v-model:limit-rate="activeItem.limitRate"
            v-model:ffmpeg-args="activeItem.ffmpegArgs"
            v-model:custom-args="activeItem.customArgs"
            :video-info="activeItem.videoInfo as VideoInfo"
            class="section-card"
          />
        </div>

        <DownloadBar
          :inline="showPresets"
          :estimated-size-text="estimatedSizeText"
          :disabled="
            submitting || (activeItem.isPlaylist && !activeItem.selectedPlaylistItems.length)
          "
          @download="handleDownload"
        />
      </div>
    </template>

    <n-empty v-else :description="$t('pending.empty')" class="empty-state">
      <template #extra>
        <n-button type="primary" round @click="handleBackToHome">
          <template #icon>
            <n-icon><icon-mdi-magnify /></n-icon>
          </template>
          {{ $t("pending.goParse") }}
        </n-button>
      </template>
    </n-empty>
  </div>
</template>

<style scoped lang="scss">
.pending-page {
  position: relative;
  height: 100%;
  overflow-y: auto;
  padding: 16px;

  .tabs-bar {
    margin-bottom: 12px;

    :deep(.n-tabs-nav__prefix) {
      padding-right: 8px;
    }

    :deep(.n-tabs-tab) {
      padding-left: 10px;
      padding-right: 6px;
    }
  }

  .section-card {
    margin-bottom: 16px;
  }

  .pending-content {
    max-width: 1080px;
    margin-inline: auto;
    padding-bottom: 96px;
    &.has-presets {
      padding-bottom: 12px;
    }
  }

  .advanced-options {
    scroll-margin-top: 16px;
  }

  .empty-state {
    margin-top: 120px;
  }
}
</style>
