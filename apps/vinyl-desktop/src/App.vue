<script setup lang="ts">
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import IconMdiHome from "~icons/mdi/home";
import IconMdiPlaylistPlay from "~icons/mdi/playlist-play";
import IconMdiDownload from "~icons/mdi/download";
import IconMdiToolbox from "~icons/mdi/toolbox";
import type { Component } from "vue";
import { useSettingStore } from "@/stores/setting";
import { useDownloadStore } from "@/stores/download";
import { usePendingStore } from "@/stores/pending";
import { useExternalImports } from "@/composables/useExternalImports";
import { useTrayManager } from "@/composables/useTrayManager";
import { useAppBootstrap } from "@/composables/useAppBootstrap";

const router = useRouter();
const openSettings = () => router.push({ name: "settings" });
const route = useRoute();
const settingStore = useSettingStore();
const downloadStore = useDownloadStore();
const pendingStore = usePendingStore();

const { applyToolSettings, applyingToolSettings, toolSettingsFailed } = useAppBootstrap({
  pauseQueue: downloadStore.pauseQueue,
  resumeQueue: () => {
    void downloadStore.enableQueue().catch((error) => console.error("Could not start the download queue:", error));
  },
});
const { setupTray, handleQuitRequest } = useTrayManager();
const { setupExternalImportListeners } = useExternalImports();

const navBadgeCounts = computed<Record<string, number>>(() => ({
  pending: pendingStore.items.length,
  downloads: downloadStore.tasks.filter(
    (downloadTask) =>
      downloadTask.status === "downloading" ||
      downloadTask.status === "postprocessing" ||
      downloadTask.status === "queued",
  ).length,
}));

const currentRoute = computed(() => {
  const routeName = (route.name as string) ?? "";
  if (routeName.startsWith("toolbox")) return "toolbox";
  return routeName;
});

const navItems: { key: string; icon: Component; labelKey: string }[] = [
  { key: "home", icon: IconMdiHome, labelKey: "nav.home" },
  { key: "pending", icon: IconMdiPlaylistPlay, labelKey: "nav.pending" },
  { key: "downloads", icon: IconMdiDownload, labelKey: "nav.downloads" },
  { key: "toolbox", icon: IconMdiToolbox, labelKey: "nav.toolbox" },
];

const currentAppWindow = getCurrentWindow();

/** 当前应用版本号 */
const appVersion = ref("");

// 窗口关闭事件拦截
currentAppWindow.onCloseRequested(async (closeEvent) => {
  if (settingStore.showTrayIcon && settingStore.closeToTray) {
    closeEvent.preventDefault();
    await currentAppWindow.hide();
  } else {
    closeEvent.preventDefault();
    handleQuitRequest();
  }
});

onMounted(async () => {
  void getVersion().then((version) => { appVersion.value = version; }).catch(() => {});
  await applyToolSettings();
  if (settingStore.startMaximized) await currentAppWindow.maximize().catch(() => {});
  await currentAppWindow.show().catch((error) => console.error("Could not show the window:", error));
  // A tool preference or optional integration failure must not silently disable
  // the rest of the application, including the UI used to recover.
  const integrations = await Promise.allSettled([setupExternalImportListeners(), setupTray()]);
  for (const result of integrations) {
    if (result.status === "rejected") console.warn("Could not initialize a desktop integration:", result.reason);
  }
});
</script>

<template>
  <Provider>
    <CookieModal />
    <SetupModal />
    <MigrationModal />
    <n-layout class="vinyl-app-shell" style="height: 100vh">
      <n-layout-header role="banner" bordered class="app-header">
        <div class="header-side">
          <RouterLink class="logo" :to="{ name: 'home' }" aria-label="NexusDownloader">
            <img src="/runout-wordmark.svg" alt="NexusDownloader" class="logo-img" />
          </RouterLink>
        </div>
        <nav class="header-nav" :aria-label="$t('nav.navigation')">
          <n-badge
            v-for="item in navItems"
            :key="item.key"
            :value="navBadgeCounts[item.key] || 0"
            :max="99"
            :show="(navBadgeCounts[item.key] || 0) > 0"
            color="#ad7f28"
            :offset="[-6, 4]"
          >
            <n-button
              :quaternary="currentRoute !== item.key"
              :type="currentRoute === item.key ? 'primary' : 'default'"
              :secondary="currentRoute === item.key"
              :aria-label="$t(item.labelKey)"
              :title="$t(item.labelKey)"
              :aria-current="currentRoute === item.key ? 'page' : undefined"
              round
              @click="router.push({ name: item.key })"
            >
              <template #icon>
                <n-icon aria-hidden="true">
                  <component :is="item.icon" />
                </n-icon>
              </template>
              <span class="nav-label" :class="{ expanded: currentRoute === item.key }">
                {{ $t(item.labelKey) }}
              </span>
            </n-button>
          </n-badge>
        </nav>
        <div class="header-side header-side-right">
          <n-button
            quaternary
            circle
            tag="a"
            href="https://github.com/sadapay404/NexusDownloader"
            :aria-label="$t('settings.repository')"
            :title="$t('settings.repository')"
            rel="noopener noreferrer"
            target="_blank"
          >
            <template #icon>
              <n-icon aria-hidden="true">
                <icon-mdi-github />
              </n-icon>
            </template>
          </n-button>
          <n-button
            :title="$t('settings.title')"
            :aria-label="$t('settings.title')"
            :type="currentRoute === 'settings' ? 'primary' : 'default'"
            :secondary="currentRoute === 'settings'"
            :quaternary="currentRoute !== 'settings'"
            circle
            @click="openSettings"
          >
            <template #icon>
              <n-icon aria-hidden="true">
                <icon-mdi-cog />
              </n-icon>
            </template>
          </n-button>
        </div>
      </n-layout-header>
      <n-layout
        position="absolute"
        style="top: 56px; bottom: 32px"
        content-style="display: flex; flex-direction: column; height: 100%; overflow: hidden;"
        :native-scrollbar="false"
      >
        <main class="app-route-view">
          <n-alert v-if="toolSettingsFailed" class="startup-alert" type="warning" role="alert">
            <n-flex align="center" :size="8">
              <span>{{ $t("setup.bootstrapFailed") }}</span>
              <n-button size="small" :loading="applyingToolSettings" @click="applyToolSettings">
                {{ $t("setup.retryToolSettings") }}
              </n-button>
            </n-flex>
          </n-alert>
          <router-view v-slot="{ Component: RouteComponent }">
            <Transition name="fade-slide" mode="out-in">
              <component :is="RouteComponent" />
            </Transition>
          </router-view>
        </main>
      </n-layout>
      <AppStatusBar :title="appVersion ? `NexusDownloader v${appVersion}` : undefined" />
    </n-layout>
  </Provider>
</template>

<style scoped lang="scss">
.startup-alert {
  flex-shrink: 0;
  margin: 8px 12px 0;
}

.app-header {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;

  .header-side {
    width: 120px;
    flex-shrink: 0;
    display: flex;
    align-items: center;

    &.header-side-right {
      justify-content: flex-end;
      gap: 4px;
    }
  }

  .logo {
    display: inline-flex;
    align-items: center;
    min-height: 38px;
    border-radius: 4px;

    &:focus-visible {
      outline: 2px solid var(--vinyl-accent);
      outline-offset: 4px;
    }
    .logo-img {
      width: clamp(92px, 12vw, 116px);
      height: auto;
      display: block;
    }
  }

  .header-nav {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;

    :deep(.n-button) {
      .n-button__content {
        overflow: visible;
        transition:
          max-width 0.2s ease,
          opacity 0.2s ease;
      }

      .n-button__icon {
        margin-right: 0;
      }

      &:not(.n-button--color) .n-button__icon {
        margin-left: 0;
      }
    }

    .nav-label {
      display: inline-block;
      max-width: 110px;
      opacity: 1;
      overflow: hidden;
      white-space: nowrap;
      line-height: normal;
      padding-bottom: 0.18em;
      margin-bottom: -0.18em;
      transition:
        max-width 0.2s ease,
        opacity 0.2s ease,
        margin 0.2s ease;
      margin-inline-start: 4px;

      &.expanded {
        max-width: 80px;
        opacity: 1;
        margin-left: 4px;
      }
    }
  }
}

@media (max-width: 820px) {
  .app-header .header-nav .nav-label:not(.expanded) {
    max-width: 0;
    opacity: 0;
    margin-inline-start: 0;
  }
}
@media (max-width: 605px) {
  .app-header {
    padding-inline: 10px;
  }
  .app-header .header-side {
    width: auto;
    min-width: 96px;
  }
  .app-header .header-nav {
    gap: 0;
  }
}

.app-route-view {
  flex: 1;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
