<script setup lang="ts">
import { normalizeAudioFormat, normalizeVideoFormat } from "@/utils/normalizer";
import { getCodecKey, getCodecLabel } from "@/utils/formats";
import { hasAudio, videoFormatsForMode } from "@/utils/vinylSelection";
import { useSettingStore } from "@/stores/setting";
import { useI18n } from "vue-i18n";
import type { VideoFormat, VideoInfo } from "@/types";

const { t } = useI18n();
const settingStore = useSettingStore();

const props = defineProps<{
  videoFormats: VideoFormat[];
  audioFormats: VideoFormat[];
  videoInfo: VideoInfo;
  extractAudio?: boolean;
  isPlaylist?: boolean;
  noMerge?: boolean;
}>();

const downloadMode = defineModel<"default" | "video" | "audio">("downloadMode", {
  required: true,
});
const selectedVideoFormat = defineModel<string>("selectedVideoFormat", {
  required: true,
});
const selectedAudioFormat = defineModel<string>("selectedAudioFormat", {
  required: true,
});

const selectedVideoCodec = ref("all");
const selectedAudioCodec = ref("all");
const multipleAudio = computed(() => downloadMode.value === "default" && !props.extractAudio);

const handleAudioFormatChange = (value: string | string[] | null) => {
  selectedAudioFormat.value = Array.isArray(value) ? value.join("+") : value || "";
};

watch(
  [downloadMode, () => props.extractAudio],
  ([mode, extractAudio]) => {
    if (mode === "audio" || extractAudio) {
      selectedAudioFormat.value = selectedAudioFormat.value.split("+")[0] || "";
    }
  },
  { immediate: true },
);

const createCodecOptions = (formats: VideoFormat[]) => {
  const codecs = new Map<string, string>();
  for (const format of formats) {
    const codec = format.vcodec && format.vcodec !== "none" ? format.vcodec : format.acodec;
    codecs.set(getCodecKey(codec), getCodecLabel(codec));
  }
  return [
    { label: t("detail.allCodecs"), value: "all" },
    ...Array.from(codecs, ([value, label]) => ({ value, label })),
  ];
};

const modeVideoFormats = computed(() => videoFormatsForMode(props.videoFormats, downloadMode.value));
const selectedVideo = computed(() => props.videoFormats.find((f) => f.format_id === selectedVideoFormat.value));
const noAudioForVideo = computed(() => downloadMode.value === "default" && !props.extractAudio &&
  selectedVideo.value && !hasAudio(selectedVideo.value) && !props.audioFormats.length);
const videoCodecOptions = computed(() => createCodecOptions(modeVideoFormats.value));
const audioCodecOptions = computed(() => createCodecOptions(props.audioFormats));

const filteredVideoFormats = computed(() =>
  selectedVideoCodec.value === "all"
    ? modeVideoFormats.value
    : modeVideoFormats.value.filter(
        (format) => getCodecKey(format.vcodec) === selectedVideoCodec.value,
      ),
);

const filteredAudioFormats = computed(() =>
  selectedAudioCodec.value === "all"
    ? props.audioFormats
    : props.audioFormats.filter(
        (format) => getCodecKey(format.acodec) === selectedAudioCodec.value,
      ),
);

function chooseVideo(id: string) {
  if (selectedVideoFormat.value === id) return;
  selectedVideoFormat.value = id;
  if (hasAudio(selectedVideo.value) && !props.extractAudio) selectedAudioFormat.value = "";
}

function chooseMode(mode: "default" | "video" | "audio") {
  downloadMode.value = mode;
  if (mode !== "audio" && !modeVideoFormats.value.some((format) => format.format_id === selectedVideoFormat.value)) {
    chooseVideo(props.isPlaylist ? "" : modeVideoFormats.value[0]?.format_id ?? "");
  }
}

/** 是否为正在直播 */
const isLive = computed(
  () => props.videoInfo.is_live === true || props.videoInfo.live_status === "is_live",
);

/** 视频格式下拉选项（规范化固定结构：清晰度+帧率 · 编码 · 动态范围 · 容器 · 大小 · 编号） */
const videoFormatOptions = computed(() => {
  const duration = props.videoInfo.duration || 0;
  const options = filteredVideoFormats.value.map((f) => {
    const n = normalizeVideoFormat(f, duration);
    const parts = [
      `${n.resolutionLabel}${n.fpsLabel ? ` ${n.fpsLabel}` : ""}`,
      n.codec, n.dynamicRange, n.container, n.filesizeLabel,
      hasAudio(f) ? t("detail.builtInAudio") : t("detail.videoStream"),
      `#${n.formatId}`,
    ].filter(Boolean);
    return { label: parts.join(" · "), value: n.formatId };
  });
  return props.isPlaylist ? [{ label: t("detail.automaticFormat"), value: "" }, ...options] : options;
});

/** 音频格式下拉选项（规范化固定结构：[语言 · 角色] · 码率 · 编码 · 声道 · 容器 · 大小 · 编号） */
const audioFormatOptions = computed(() => {
  const duration = props.videoInfo.duration || 0;
  return filteredAudioFormats.value.map((f) => {
    const n = normalizeAudioFormat(f, duration);
    const langInfo = [n.languageLabel || n.language, n.roleLabel].filter(Boolean).join(" · ");
    const parts = [
      langInfo ? `[${langInfo}]` : "",
      n.bitrateLabel,
      n.codec,
      n.channelsLabel,
      n.container,
      n.filesizeLabel,
      `#${n.formatId}`,
    ].filter(Boolean);
    return {
      label: parts.join(" · "),
      value: n.formatId,
    };
  });
});

const handleVideoCodecChange = (value: string) => {
  settingStore.preferredVideoCodec = value;
  selectedVideoCodec.value = value;
  const currentIsVisible = filteredVideoFormats.value.some(
    (format) => format.format_id === selectedVideoFormat.value,
  );
  if (!currentIsVisible) chooseVideo(filteredVideoFormats.value[0]?.format_id || "");
};

const handleAudioCodecChange = (value: string) => {
  settingStore.preferredAudioCodec = value;
  selectedAudioCodec.value = value;
  const visibleSelections = selectedAudioFormat.value
    .split("+")
    .filter((id) => filteredAudioFormats.value.some((format) => format.format_id === id));
  selectedAudioFormat.value = visibleSelections.length
    ? visibleSelections.join("+")
    : filteredAudioFormats.value[0]?.format_id || "";
};

watch(
  [
    () => props.videoInfo,
    () => props.videoFormats,
    selectedVideoFormat,
    () => settingStore.preferredVideoCodec,
  ],
  () => {
    const preferred = settingStore.preferredVideoCodec;
    const selected = props.videoFormats.find(
      (format) => format.format_id === selectedVideoFormat.value,
    );
    selectedVideoCodec.value =
      videoCodecOptions.value.some((option) => option.value === preferred) &&
      (!selected || getCodecKey(selected.vcodec) === preferred)
        ? preferred
        : "all";
  },
  { immediate: true },
);

watch(
  [
    () => props.videoInfo,
    () => props.audioFormats,
    selectedAudioFormat,
    () => settingStore.preferredAudioCodec,
  ],
  () => {
    const preferred = settingStore.preferredAudioCodec;
    const selectedIds = selectedAudioFormat.value.split("+");
    const selectionsMatch = props.audioFormats
      .filter((format) => selectedIds.includes(format.format_id))
      .every((format) => getCodecKey(format.acodec) === preferred);
    selectedAudioCodec.value =
      audioCodecOptions.value.some((option) => option.value === preferred) && selectionsMatch
        ? preferred
        : "all";
  },
  { immediate: true },
);
</script>

<template>
  <n-card :title="$t('detail.downloadMethod')" size="small">
    <n-flex vertical :size="12">
      <n-radio-group :value="downloadMode" size="small" :aria-label="$t('detail.downloadMethod')" @update:value="chooseMode">
        <n-radio-button value="default">{{ $t("common.default") }}</n-radio-button>
        <n-radio-button value="video" :disabled="!videoFormats.some((format) => !hasAudio(format))">{{ $t("detail.videoOnly") }}</n-radio-button>
        <n-radio-button value="audio">{{ $t("detail.audioOnly") }}</n-radio-button>
      </n-radio-group>

      <n-alert v-if="isPlaylist" type="info" :bordered="false">
        {{ $t("detail.playlistFormatHint") }}
      </n-alert>
      <n-alert v-if="noAudioForVideo && !noMerge" type="warning" :bordered="false">
        {{ $t("detail.noAudioForFormat") }}
      </n-alert>

      <n-alert v-if="isLive" type="info" :bordered="false">
        {{ $t("detail.liveFormatHint") }}
      </n-alert>

      <n-flex v-if="downloadMode !== 'audio' && videoFormatOptions.length" align="center" :size="8">
        <n-text depth="3" style="font-size: 13px; flex-shrink: 0">
          {{ $t("detail.video") }}
        </n-text>
        <n-select
          :value="selectedVideoCodec"
          :options="videoCodecOptions"
          size="small"
          style="width: 118px; flex-shrink: 0"
          :aria-label="$t('detail.codec')"
          @update:value="handleVideoCodecChange"
        />
        <n-select
          :value="selectedVideoFormat || (isPlaylist ? '' : null)"
          :aria-label="$t('detail.videoFormatChoice')"
          :options="videoFormatOptions"
          size="small"
          style="min-width: 0"
          @update:value="chooseVideo"
        />
      </n-flex>

      <n-flex v-if="downloadMode !== 'video' && audioFormatOptions.length" align="center" :size="8">
        <n-text depth="3" style="font-size: 13px; flex-shrink: 0">
          {{ $t("detail.audio") }}
        </n-text>
        <n-select
          :value="selectedAudioCodec"
          :options="audioCodecOptions"
          size="small"
          style="width: 118px; flex-shrink: 0"
          :aria-label="$t('detail.codec')"
          @update:value="handleAudioCodecChange"
        />
        <n-select
          :value="
            multipleAudio ? selectedAudioFormat.split('+').filter(Boolean) : selectedAudioFormat
          "
          :multiple="multipleAudio"
          clearable
          :placeholder="$t('detail.automaticAudio')"
          :aria-label="$t('detail.audioFormatChoice')"
          :options="audioFormatOptions"
          size="small"
          style="min-width: 0"
          @update:value="handleAudioFormatChange"
        />
      </n-flex>
    </n-flex>
  </n-card>
</template>
