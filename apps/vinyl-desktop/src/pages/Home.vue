<script setup lang="ts">
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { isValidUrl } from "@/utils/validate";
import { useVideoStore } from "@/stores/video";
import { createPendingItem, usePendingStore } from "@/stores/pending";
import { useHistoryStore } from "@/stores/history";
import { useStatusStore } from "@/stores/status";
import { armVinylSelection, clipboardVideo, markClipboardVideo } from "@/utils/vinylSelection";
import { useSettingStore } from "@/stores/setting";
import { useDownloadLauncher } from "@/composables/useDownloadLauncher";
import { useI18n } from "vue-i18n";
import type { FetchedVideoData, HomeMode } from "@/types";

const { t: translate, tm: translateMessage } = useI18n();
const router = useRouter();
const route = useRoute();
const videoStore = useVideoStore();
const pendingStore = usePendingStore();
const historyStore = useHistoryStore();
const settingStore = useSettingStore();
const statusStore = useStatusStore();
const { createPreparingTask, markPreparationError, launchDownload } = useDownloadLauncher();

const url = ref("");
const batchInput = ref("");
const batchParsing = ref(false);
const standardSubmitting = ref(false);
const showQuickSettings = ref(false);
const BATCH_LIMIT = 50;

/**
 * 从多行或空格分隔的文本中提取并去重有效网址
 *
 * @param sourceText 输入的文本内容
 * @returns 提取到的有效 URL 字符串列表
 */
const extractUrls = (sourceText: string): string[] =>
  Array.from(
    new Set(
      sourceText
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(isValidUrl),
    ),
  );

const batchUrls = computed(() => extractUrls(batchInput.value));
const isBusy = computed(
  () => videoStore.fetching || batchParsing.value || standardSubmitting.value,
);

const historyIndex = ref(-1);
const showHistory = ref(false);
let readingClipboard = false;
const isStandardInspection = () =>
  settingStore.homeMode === "standard" && settingStore.homeDownloadBehavior === "pending";
const canReadClipboard = () =>
  route.name === "home" &&
  document.hasFocus() &&
  document.visibilityState === "visible" &&
  isStandardInspection() &&
  !url.value.trim() &&
  !isBusy.value &&
  !showHistory.value &&
  !showQuickSettings.value &&
  !statusStore.showCookieModal &&
  !statusStore.showDenoSetupModal &&
  !statusStore.showFfmpegSetupModal &&
  !statusStore.showYtdlpSetupModal;

async function inspectClipboardOnFocus() {
  if (readingClipboard || !canReadClipboard()) return;
  readingClipboard = true;
  try {
    const candidate = clipboardVideo(await readText());
    if (!candidate || !canReadClipboard() || !markClipboardVideo(candidate.id)) return;
    url.value = candidate.url;
    await handleSearch();
  } catch {
    // Unavailable clipboard access must not prevent ordinary typing or pasting.
  } finally {
    readingClipboard = false;
  }
}

function handleNativePaste(event: ClipboardEvent) {
  if (!isStandardInspection() || isBusy.value) return;
  const candidate = clipboardVideo(event.clipboardData?.getData("text/plain") || "");
  if (!candidate) return;
  event.preventDefault();
  markClipboardVideo(candidate.id);
  url.value = candidate.url;
  void handleSearch();
}

onMounted(() => {
  window.addEventListener("focus", inspectClipboardOnFocus);
  void inspectClipboardOnFocus();
});
onUnmounted(() => window.removeEventListener("focus", inspectClipboardOnFocus));

/**
 * 监听标准模式输入框键盘事件（Enter 触发搜索，上下键翻查历史记录）
 *
 * @param keyboardEvent 键盘按键事件对象
 */
const handleKeydown = (keyboardEvent: KeyboardEvent): void => {
  if (keyboardEvent.key === "Enter") {
    handleSearch();
    return;
  }

  if (historyStore.urls.length === 0) return;

  if (keyboardEvent.key === "ArrowUp") {
    keyboardEvent.preventDefault();
    if (historyIndex.value < historyStore.urls.length - 1) {
      historyIndex.value++;
    }
    url.value = historyStore.urls[historyIndex.value];
  } else if (keyboardEvent.key === "ArrowDown") {
    keyboardEvent.preventDefault();
    if (historyIndex.value > 0) {
      historyIndex.value--;
      url.value = historyStore.urls[historyIndex.value];
    } else {
      historyIndex.value = -1;
      url.value = "";
    }
  }
};

/**
 * 输入框内容变动时重置历史记录索引游标
 */
const handleInput = (): void => {
  historyIndex.value = -1;
};

/**
 * 从历史记录抽屉中选中指定 URL 填充到输入框并关闭抽屉
 *
 * @param selectedUrl 用户选中的历史 URL
 */
const selectHistory = (selectedUrl: string): void => {
  url.value = selectedUrl;
  showHistory.value = false;
  historyIndex.value = -1;
};

/**
 * 读取系统剪贴板内容并根据当前模式自动填充到对应输入框
 *
 * @returns Promise<void>
 */
const handlePaste = async (): Promise<void> => {
  try {
    const clipboardContent = await readText();
    const trimmedContent = clipboardContent.trim();
    if (!trimmedContent) {
      window.$message.warning(translate("clipboard.empty"));
      return;
    }
    if (isBusy.value || route.name !== "home") return;
    if (settingStore.homeMode === "batch") {
      const parsedUrls = extractUrls(trimmedContent);
      if (parsedUrls.length === 0) {
        window.$message.warning(translate("clipboard.invalidUrl"));
        return;
      }
      batchInput.value = parsedUrls.join("\n");
      window.$message.success(translate("home.batchPasted", { count: parsedUrls.length }));
    } else {
      if (!isValidUrl(trimmedContent)) {
        window.$message.warning(translate("clipboard.invalidUrl"));
        return;
      }
      url.value = trimmedContent;
      historyIndex.value = -1;
      window.$message.success(translate("clipboard.pasteSuccess"));
      const candidate = isStandardInspection() && clipboardVideo(trimmedContent);
      if (candidate) {
        markClipboardVideo(candidate.id);
        await handleSearch();
      }
    }
  } catch {
    window.$message.warning(translate("clipboard.readFailed"));
  }
};

/**
 * 将毫秒时间戳转换为易读的历史时间字符串（如“今天 14:30”或日期时间）
 *
 * @param historyTimestamp 历史记录产生的时间戳
 * @returns 格式化后的时间字符串
 */
const formatHistoryTime = (historyTimestamp: number): string => {
  if (!historyTimestamp) return "";
  const now = new Date();
  const targetDate = new Date(historyTimestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const dayDifference = (today.getTime() - targetDay.getTime()) / 86400000;
  const timeString = `${String(targetDate.getHours()).padStart(2, "0")}:${String(targetDate.getMinutes()).padStart(2, "0")}`;

  if (dayDifference === 0) return `${translate("downloads.today")} ${timeString}`;
  if (dayDifference === 1) return `${translate("downloads.yesterday")} ${timeString}`;
  if (dayDifference === 2) return `${translate("downloads.dayBeforeYesterday")} ${timeString}`;
  return `${targetDate.getFullYear()}/${String(targetDate.getMonth() + 1).padStart(2, "0")}/${String(targetDate.getDate()).padStart(2, "0")} ${timeString}`;
};

const currentTipIndex = ref(0);
watchEffect((onCleanup) => {
  if (!settingStore.showHomeTips) return;
  const timer = setInterval(() => {
    const tipsList = translateMessage("home.tips") as string[];
    currentTipIndex.value = tipsList.length ? (currentTipIndex.value + 1) % tipsList.length : 0;
  }, 4000);
  onCleanup(() => clearInterval(timer));
});

/**
 * 响应来自深链接、命令行或浏览器扩展的外部 URL 导入：
 * 自动识别并适配标准模式与批量模式：
 * 1. 明确指定 batch 模式或导入多个链接时，自动切入批量模式并去重追加到批量输入框；
 * 2. 明确指定 standard 模式时，切入标准模式并自动执行单条解析；
 * 3. 未显式指定模式时，尊重当前客户端所处的模式，避免在批量模式下打乱用户界面。
 *
 * @param routeQuery 包含 url、urls、mode 等参数的路由 Query 对象
 */
const applyExternalImport = (routeQuery: Record<string, unknown>): void => {
  const targetMode = routeQuery.mode as HomeMode | undefined;
  let importedUrls: string[] = [];

  if (typeof routeQuery.urls === "string") {
    try {
      const parsedUrlArray = JSON.parse(routeQuery.urls);
      if (Array.isArray(parsedUrlArray)) {
        importedUrls = parsedUrlArray.filter(
          (urlCandidate): urlCandidate is string =>
            typeof urlCandidate === "string" && isValidUrl(urlCandidate),
        );
      }
    } catch {
      importedUrls = extractUrls(routeQuery.urls);
    }
  }

  if (typeof routeQuery.url === "string") {
    const singleUrl = routeQuery.url.trim();
    if (isValidUrl(singleUrl) && !importedUrls.includes(singleUrl)) {
      importedUrls.push(singleUrl);
    }
  }

  if (importedUrls.length === 0) return;

  router.replace({ name: "home", query: {} });

  const effectiveMode: HomeMode =
    targetMode || (importedUrls.length > 1 ? "batch" : settingStore.homeMode);

  if (effectiveMode === "batch") {
    settingStore.homeMode = "batch";
    const existingUrls = extractUrls(batchInput.value);
    const mergedUrls = Array.from(new Set([...existingUrls, ...importedUrls]));
    batchInput.value = mergedUrls.join("\n");
    window.$message.success(translate("home.batchPasted", { count: importedUrls.length }));
  } else {
    settingStore.homeMode = "standard";
    url.value = importedUrls[0];
    historyIndex.value = -1;
    handleSearch();
  }
};

onMounted(() => {
  if (route.query.url || route.query.urls) {
    applyExternalImport(route.query);
  }
});

// 监听 query 变化（已在首页时收到新导入或深链接）
watch(
  () => [route.query.url, route.query.urls, route.query._t],
  ([newUrl, newUrls]) => {
    if (newUrl || newUrls) {
      applyExternalImport(route.query);
    }
  },
);

/**
 * 处理视频解析成功后的数据分发（加入待下载列表或发起快速下载任务）
 *
 * @param videoData 解析成功的视频详细元数据
 * @param preparingTaskId 提前占位的准备中任务 ID（可选）
 * @returns Promise<boolean> 是否成功提交处理
 */
const handleParsedData = async (
  videoData: FetchedVideoData,
  preparingTaskId?: string,
): Promise<boolean> => {
  if (settingStore.homeDownloadBehavior === "pending") {
    pendingStore.add(videoData);
    return true;
  }

  const downloadResult = await launchDownload(createPendingItem(videoData, true), preparingTaskId);
  return downloadResult === "started" || downloadResult === "queued";
};

/**
 * 校验快速下载模式所需配置（如下载路径是否已设置）
 *
 * @returns boolean 配置是否就绪
 */
const ensureQuickDownloadConfigured = (): boolean => {
  if (settingStore.homeDownloadBehavior !== "quick" || settingStore.downloadDir) return true;
  window.$message.warning(translate("detail.setDownloadDirFirst"));
  showQuickSettings.value = true;
  return false;
};

/**
 * 执行标准模式下的单条视频链接解析与下载提交流程
 *
 * @returns Promise<void>
 */
async function handleSearch(): Promise<void> {
  if (isBusy.value) return;
  const trimmedUrl = url.value.trim();
  if (!trimmedUrl) return;
  if (!isValidUrl(trimmedUrl)) {
    window.$message.warning(translate("home.enterValidUrl"));
    return;
  }
  if (!ensureQuickDownloadConfigured()) return;
  standardSubmitting.value = true;
  const candidate = clipboardVideo(trimmedUrl);
  if (candidate) markClipboardVideo(candidate.id);
  const quick = settingStore.homeDownloadBehavior === "quick";
  try {
    const preparingTaskId = quick ? await createPreparingTask(trimmedUrl) : undefined;
    if (preparingTaskId) await router.push({ name: "downloads" });
    const fetchedData = await videoStore.fetchVideoInfo(trimmedUrl, {
      customArgs: quick
        ? settingStore.quickCustomArgs || settingStore.defaultCustomArgs
        : settingStore.defaultCustomArgs,
    });
    if (fetchedData) {
      historyStore.add(trimmedUrl, fetchedData.videoInfo.title);
      if (quick) {
        await launchDownload(createPendingItem(fetchedData, true), preparingTaskId);
      } else {
        const pendingId = pendingStore.add(fetchedData);
        if (route.name === "home") {
          armVinylSelection(pendingId);
          await router.push({ name: "pending" });
        }
      }
    } else if (preparingTaskId) {
      await markPreparationError(preparingTaskId);
    }
  } finally {
    standardSubmitting.value = false;
  }
}

/**
 * 批量解析去重后的链接列表（逐项顺序解析以防瞬时占用过多系统进程）
 *
 * @returns Promise<void>
 */
const handleBatchSearch = async (): Promise<void> => {
  if (isBusy.value) return;
  const targetUrls = batchUrls.value;
  if (targetUrls.length === 0) {
    window.$message.warning(translate("home.batchEmpty"));
    return;
  }
  if (targetUrls.length > BATCH_LIMIT) {
    window.$message.warning(translate("home.batchLimit", { count: BATCH_LIMIT }));
    return;
  }
  if (!ensureQuickDownloadConfigured()) return;

  batchParsing.value = true;
  let succeededCount = 0;
  const preparingTasks = new Map<string, string>();
  if (settingStore.homeDownloadBehavior === "quick") {
    for (const targetUrl of targetUrls) {
      preparingTasks.set(targetUrl, await createPreparingTask(targetUrl));
    }
  }
  if (preparingTasks.size > 0) await router.push({ name: "downloads" });

  try {
    for (const targetUrl of targetUrls) {
      const fetchedData = await videoStore.fetchVideoInfo(targetUrl, {
        silent: true,
        customArgs:
          settingStore.homeDownloadBehavior === "quick"
            ? settingStore.quickCustomArgs || settingStore.defaultCustomArgs
            : settingStore.defaultCustomArgs,
      });
      if (fetchedData) {
        historyStore.add(targetUrl, fetchedData.videoInfo.title);
        if (await handleParsedData(fetchedData, preparingTasks.get(targetUrl))) {
          succeededCount += 1;
        }
      } else {
        const preparingTaskId = preparingTasks.get(targetUrl);
        if (preparingTaskId) await markPreparationError(preparingTaskId);
      }
    }
  } finally {
    batchParsing.value = false;
  }

  if (succeededCount > 0) {
    window.$message.success(
      translate("home.batchComplete", {
        succeeded: succeededCount,
        failed: targetUrls.length - succeededCount,
      }),
    );
    batchInput.value = "";
    if (settingStore.homeDownloadBehavior === "pending") router.push({ name: "pending" });
  } else {
    window.$message.error(translate("home.batchAllFailed"));
  }
};
</script>

<template>
  <div class="home-page">
    <section class="record-sleeve" :aria-label="$t('vinyl.intake')">
      <div class="sleeve-legend">
        <span>
          <b>{{ $t("vinyl.sideA") }}</b>
          <i></i>
          {{ $t("vinyl.intake") }}
        </span>
        <span>
          <i class="edition-light"></i>
          {{ $t("vinyl.localDesktop") }}
        </span>
      </div>
      <n-flex vertical align="center" justify="center" :size="18" class="search-view">
        <div class="hero-heading">
          <h1>
            {{ $t("vinyl.heroFirst") }}
            <br />
            {{ $t("vinyl.heroSecond") }}
            <em>{{ $t("vinyl.heroAccent") }}</em>
          </h1>
          <p>{{ $t("vinyl.heroDescription") }}</p>
        </div>
        <n-flex :size="8">
          <n-button
            size="small"
            strong
            secondary
            round
            :disabled="isBusy"
            :type="settingStore.homeMode === 'standard' ? 'primary' : 'default'"
            @click="settingStore.homeMode = 'standard'"
          >
            {{ $t("home.standardMode") }}
          </n-button>
          <n-button
            size="small"
            strong
            secondary
            round
            :disabled="isBusy"
            :type="settingStore.homeMode === 'batch' ? 'primary' : 'default'"
            @click="settingStore.homeMode = 'batch'"
          >
            {{ $t("home.batchMode") }}
          </n-button>
        </n-flex>

        <div class="input-stage" :class="{ 'is-batch': settingStore.homeMode === 'batch' }">
          <Transition name="mode-fade">
            <div v-if="settingStore.homeMode === 'standard'" key="standard" class="input-panel">
              <div class="link-row">
                <n-input
                  v-model:value="url"
                  :placeholder="$t('home.inputPlaceholder')"
                  :input-props="{
                    'aria-label': $t('vinyl.linkField'),
                    spellcheck: false,
                    autocomplete: 'off',
                  }"
                  size="large"
                  clearable
                  :disabled="isBusy"
                  @keydown="handleKeydown"
                  @input="handleInput"
                  @focus="inspectClipboardOnFocus"
                  @paste="handleNativePaste"
                >
                  <template #prefix>
                    <n-icon><icon-mdi-link-variant /></n-icon>
                  </template>
                </n-input>
                <n-button
                  type="primary"
                  strong
                  size="large"
                  class="link-submit"
                  :loading="videoStore.fetching"
                  :disabled="!url.trim() || isBusy"
                  @click="handleSearch"
                >
                  <template #icon>
                    <n-icon>
                      <icon-mdi-download v-if="settingStore.homeDownloadBehavior === 'quick'" />
                      <icon-mdi-magnify v-else />
                    </n-icon>
                  </template>
                  {{
                    settingStore.homeDownloadBehavior === "quick"
                      ? $t("common.download")
                      : $t("home.parse")
                  }}
                </n-button>
              </div>
              <div class="submit-row">
                <div class="submit-left">
                  <DownloadBehaviorControls
                    v-model="settingStore.homeDownloadBehavior"
                    :disabled="isBusy"
                    @settings="showQuickSettings = true"
                  />
                </div>
              </div>
            </div>

            <div v-else key="batch" class="input-panel">
              <n-input
                v-model:value="batchInput"
                type="textarea"
                :placeholder="$t('home.batchPlaceholder')"
                :autosize="{ minRows: 3, maxRows: 3 }"
                :disabled="isBusy"
                @keydown.ctrl.enter.prevent="handleBatchSearch"
              />

              <div class="submit-row">
                <div class="submit-left">
                  <DownloadBehaviorControls
                    v-model="settingStore.homeDownloadBehavior"
                    :disabled="isBusy"
                    @settings="showQuickSettings = true"
                  />
                </div>

                <n-button
                  type="primary"
                  strong
                  secondary
                  round
                  :loading="batchParsing"
                  :disabled="batchUrls.length === 0 || isBusy"
                  @click="handleBatchSearch"
                >
                  <template #icon>
                    <n-icon>
                      <icon-mdi-download v-if="settingStore.homeDownloadBehavior === 'quick'" />
                      <icon-mdi-magnify v-else />
                    </n-icon>
                  </template>
                  {{
                    settingStore.homeDownloadBehavior === "quick"
                      ? $t("common.download")
                      : $t("home.parseBatch", { count: batchUrls.length })
                  }}
                </n-button>
              </div>
            </div>
          </Transition>
        </div>
        <n-flex :size="8" justify="center">
          <n-button size="small" strong secondary round :disabled="isBusy" @click="handlePaste">
            <template #icon>
              <n-icon size="14"><icon-mdi-content-paste /></n-icon>
            </template>
            {{ $t("common.paste") }}
          </n-button>
          <n-button
            size="small"
            strong
            secondary
            round
            :disabled="historyStore.items.length === 0"
            @click="showHistory = true"
          >
            <template #icon>
              <n-icon size="14"><icon-mdi-history /></n-icon>
            </template>
            {{ $t("home.parseHistory") }}
          </n-button>
        </n-flex>
        <div class="sleeve-feedback" role="status">
          <Transition name="tip-fade" mode="out-in">
            <div v-if="isBusy" class="inspection-status">
              <VinylDisc small spinning />
              <span>{{ $t("vinyl.checkingLink") }}</span>
            </div>
            <n-text
              v-else-if="settingStore.showHomeTips && isStandardInspection()"
              depth="3"
              class="intake-hint"
            >
              {{ $t("vinyl.clipboardHint") }}
            </n-text>
            <n-text
              v-else-if="settingStore.showHomeTips"
              :key="currentTipIndex"
              depth="3"
              class="intake-hint"
            >
              {{ $t(`home.tips[${currentTipIndex}]`) }}
            </n-text>
          </Transition>
        </div>
      </n-flex>
    </section>
    <footer class="runout-credit">
      Proudly Created by
      <strong>Sheikh Arsalan</strong>
      in Colaboration with
      <strong>Mubashir</strong>
    </footer>

    <n-drawer v-model:show="showHistory" :width="360" placement="right">
      <n-drawer-content :native-scrollbar="false">
        <template #header>
          <n-flex align="center" justify="space-between" style="width: 100%">
            <span>{{ $t("home.parseHistory") }}</span>
            <n-button
              size="tiny"
              strong
              secondary
              type="error"
              :disabled="historyStore.items.length === 0"
              @click="historyStore.clear()"
            >
              {{ $t("common.clear") }}
            </n-button>
          </n-flex>
        </template>
        <n-empty
          v-if="historyStore.items.length === 0"
          :description="$t('home.noHistory')"
          style="margin-top: 80px"
        />
        <n-list v-else bordered clickable>
          <n-list-item
            v-for="(item, index) in historyStore.items"
            :key="index"
            @click="selectHistory(item.url)"
          >
            <n-flex vertical :size="2" style="min-width: 0">
              <n-flex :size="4" :wrap="false" align="center" style="min-width: 0">
                <n-ellipsis :line-clamp="1" :tooltip="false" class="history-title">
                  {{ item.title || item.url }}
                </n-ellipsis>
              </n-flex>
              <n-flex :size="8" :wrap="false" align="center">
                <n-text depth="3" class="history-url">
                  <n-ellipsis :line-clamp="1" :tooltip="false">
                    {{ item.url }}
                  </n-ellipsis>
                </n-text>
                <n-text depth="3" class="history-time">
                  {{ formatHistoryTime(item.time) }}
                </n-text>
              </n-flex>
            </n-flex>
            <template #suffix>
              <n-button
                quaternary
                circle
                size="tiny"
                class="history-delete"
                @click.stop="historyStore.remove(item.url)"
              >
                <template #icon>
                  <n-icon size="14"><icon-mdi-close /></n-icon>
                </template>
              </n-button>
            </template>
          </n-list-item>
        </n-list>
      </n-drawer-content>
    </n-drawer>

    <QuickDownloadSettingsModal v-model:show="showQuickSettings" />
  </div>
</template>

<style scoped lang="scss">
.home-page {
  height: 100%;
  overflow-y: auto;
  padding: 20px clamp(14px, 3vw, 36px) 0;
}

.record-sleeve {
  --sleeve-muted: #cfc5b5;
  color: #f5f5f0;
  position: relative;
  isolation: isolate;
  max-width: 1220px;
  min-height: min(510px, 100%);
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid #6f5c3b80;
  border-radius: 20px;
  background:
    linear-gradient(102deg, #171511f6 0%, #191713e3 29%, #11100e84 72%),
    linear-gradient(0deg, #13110ef5 0%, transparent 85%),
    url("/vinyl.webp") center 57% / cover #181818;
  box-shadow:
    0 20px 60px #0004,
    inset 0 1px #fff0d418;
}

.sleeve-legend {
  display: flex;
  justify-content: space-between;
  padding: 20px clamp(15px, 3vw, 28px) 0;
  gap: 12px;
  color: var(--sleeve-muted);
  font:
    10px/1.4 ui-monospace,
    Consolas,
    monospace;
  letter-spacing: 0.16em;
  text-transform: uppercase;

  span {
    display: inline-flex;
    align-items: center;
    gap: 9px;
  }
  b {
    color: #e9c878;
    font-weight: 500;
  }
  i {
    display: inline-block;
    width: 16px;
    height: 1px;
    background: #9b794bc2;
  }
  .edition-light {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #e5a93b;
    box-shadow: 0 0 12px #e5a93b80;
  }
}

.search-view {
  padding: clamp(25px, 5vh, 56px) 22px 30px;
}

.hero-heading {
  text-align: center;
  max-width: 650px;
  margin-bottom: 5px;

  h1 {
    font-size: clamp(39px, 6.5vw, 76px);
    font-weight: 660;
    letter-spacing: -0.072em;
    line-height: 1.02;
  }
  em {
    color: #e8c675;
    font-family: Georgia, serif;
    font-weight: 500;
    letter-spacing: -0.065em;
  }
  p {
    margin-top: 15px;
    color: var(--sleeve-muted);
    font-size: clamp(13px, 1.7vw, 16px);
  }
}

.runout-credit {
  padding: 15px 0;
  text-align: center;
  color: var(--vinyl-muted);
  font-size: 12px;
  strong {
    font-weight: 650;
    color: var(--vinyl-accent);
  }
}

.link-row {
  display: flex;
  gap: 6px;
  padding: 5px;
  border: 1px solid #866e415e;
  border-radius: 12px;
  background: #1c1915ee;
  box-shadow:
    0 10px 24px #0005,
    inset 0 1px #fff0d410;
  :deep(.n-input) {
    flex: 1;
    min-width: 0;
  }
  :deep(.n-input__prefix) {
    color: #ebc67a;
    margin-inline-end: 8px;
  }
}

.link-submit {
  flex-shrink: 0;
}
.sleeve-feedback {
  min-height: 36px;
  display: grid;
  place-items: center;
  text-align: center;
}
.inspection-status {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #ecd79c;
}
.intake-hint {
  font-size: 12px;
  color: var(--sleeve-muted);
}

.input-stage {
  position: relative;
  width: 100%;
  max-width: 590px;
  height: 90px;
  transition-property: height;
  transition-duration: 180ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

.input-stage.is-batch {
  height: 132px;
}

.input-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.submit-row {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.submit-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.mode-fade-enter-active,
.mode-fade-leave-active {
  transition-property: opacity, transform;
}

.mode-fade-enter-active {
  transition-duration: 160ms;
  transition-timing-function: ease-out;
}

.mode-fade-leave-active {
  transition-duration: 120ms;
  transition-timing-function: ease-in;
}

.mode-fade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.mode-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.history-title {
  font-size: 13px;
  font-weight: 500;
  flex: 1;
  min-width: 0;
}

.history-url {
  font-size: 11px;
  flex: 1;
  min-width: 0;
}

.history-time {
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

.history-delete {
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

:deep(.n-list-item):hover .history-delete {
  opacity: 1;
}
</style>
