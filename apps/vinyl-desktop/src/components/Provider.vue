<!-- 全局配置 -->
<template>
  <n-config-provider
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
    :theme="theme"
    :theme-overrides="themeOverrides"
    abstract
    inline-theme-disabled
    preflight-style-disabled
  >
    <n-global-style />
    <n-loading-bar-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <n-message-provider :max="1" placement="bottom">
            <n-modal-provider>
              <slot />
              <NaiveProviderContent />
            </n-modal-provider>
          </n-message-provider>
        </n-notification-provider>
      </n-dialog-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import {
  zhCN,
  dateZhCN,
  enUS,
  dateEnUS,
  darkTheme,
  useOsTheme,
  useLoadingBar,
  useModal,
  useDialog,
  useMessage,
  useNotification,
  GlobalThemeOverrides,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingStore } from "@/stores/setting";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 设置
const settingStore = useSettingStore();
const { locale } = useI18n();

// Naive UI 语言：中文用中文，其他一律英文
const naiveLocale = computed(() => (locale.value.startsWith("zh") ? zhCN : enUS));
const naiveDateLocale = computed(() => (locale.value.startsWith("zh") ? dateZhCN : dateEnUS));

// 操作系统主题
const osTheme = useOsTheme();

// 获取明暗模式
const theme = computed(() => {
  return settingStore.themeMode === "auto"
    ? // 跟随系统
      osTheme.value === "dark"
      ? darkTheme
      : null
    : // 自定义
      settingStore.themeMode === "dark"
      ? darkTheme
      : null;
});

const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: theme.value
    ? {
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        borderRadius: "9px",
        bodyColor: "#121212",
        cardColor: "#181818",
        modalColor: "#211e19",
        headerColor: "#151413",
        footerColor: "#151413",
        popoverColor: "#24201a",
        inputColor: "#211e19",
        actionColor: "#211e19",
        borderColor: "#463b2b",
        dividerColor: "#3b3328",
        textColor1: "#F5F5F0",
        textColor2: "#eee8db",
        textColor3: "#c6baaa",
        placeholderColor: "#aea394",
        primaryColor: "#D4AF37",
        primaryColorHover: "#eccb73",
        primaryColorPressed: "#E5A93B",
        primaryColorSuppl: "#e3bf63",
      }
    : { borderRadius: "9px" },
  Layout: theme.value ? { color: "#121212", headerColor: "#181818", footerColor: "#181818" } : {},
  Card: theme.value ? { borderRadius: "13px" } : {},
  Button: theme.value
    ? {
        textColorPrimary: "#1a150c",
        textColorHoverPrimary: "#1a150c",
        textColorPressedPrimary: "#1a150c",
        textColorFocusPrimary: "#1a150c",
        textColorDisabledPrimary: "#1a150c",
      }
    : {},
}));

watchEffect(() => {
  document.documentElement.dataset.vinylTheme = theme.value ? "dark" : "light";
});

// 同步原生标题栏主题
const syncNativeTheme = async (): Promise<void> => {
  try {
    await getCurrentWindow().setTheme(
      settingStore.themeMode === "auto" ? null : settingStore.themeMode,
    );
  } catch (error) {
    console.warn("[NexusDownloader] failed to sync native window theme:", error);
  }
};

watch(
  () => settingStore.themeMode,
  () => void syncNativeTheme(),
  { immediate: true },
);

// 挂载工具
const NaiveProviderContent = defineComponent({
  setup() {
    // 进度条
    window.$loadingBar = useLoadingBar();
    // 通知
    window.$notification = useNotification();
    // 信息
    window.$message = useMessage();
    // 对话框
    window.$dialog = useDialog();
    // 模态框
    window.$modal = useModal();
  },
  render() {
    return h("div", { className: "main-tools" });
  },
});
</script>
