<script setup lang="ts">
import type { HomeDownloadBehavior } from "@/types";

const behavior = defineModel<HomeDownloadBehavior>({ required: true });
defineProps<{ disabled?: boolean }>();
defineEmits<{ settings: [] }>();
</script>

<template>
  <div class="behavior-controls">
    <n-tabs v-model:value="behavior" type="segment" size="small" animated class="behavior-tabs">
      <n-tab-pane name="pending" :disabled="disabled">
        <template #tab>
          <n-tooltip>
            <template #trigger>
              <span class="behavior-label">
                <n-icon aria-hidden="true" size="15"><icon-mdi-playlist-edit /></n-icon>
                {{ $t("vinyl.reviewFormats") }}
              </span>
            </template>
            {{ $t("home.pendingBehavior") }}
          </n-tooltip>
        </template>
      </n-tab-pane>
      <n-tab-pane name="quick" :disabled="disabled">
        <template #tab>
          <n-tooltip>
            <template #trigger>
              <span class="behavior-label">
                <n-icon aria-hidden="true" size="15"><icon-mdi-lightning-bolt /></n-icon>
                {{ $t("vinyl.quickDownload") }}
              </span>
            </template>
            {{ $t("home.quickBehavior") }}
          </n-tooltip>
        </template>
      </n-tab-pane>
    </n-tabs>

    <Transition name="settings-pop">
      <span v-if="behavior === 'quick'" class="settings-action">
        <n-tooltip>
          <template #trigger>
            <n-button
              size="small"
              circle
              secondary
              :aria-label="$t('home.quickSettings')"
              :disabled="disabled"
              @click="$emit('settings')"
            >
              <template #icon>
                <n-icon aria-hidden="true" size="16"><icon-mdi-cog-outline /></n-icon>
              </template>
            </n-button>
          </template>
          {{ $t("home.quickSettings") }}
        </n-tooltip>
      </span>
    </Transition>
  </div>
</template>

<style scoped>
.behavior-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.behavior-tabs {
  width: auto;
  --n-tab-border-radius: 25px;
}

.behavior-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  font-size: 12px;
}

.behavior-tabs :deep(.n-tabs-pane-wrapper) {
  display: none;
}

.settings-action {
  display: inline-flex;
  transform-origin: left center;
}

.settings-pop-enter-active,
.settings-pop-leave-active {
  transition-property: opacity, transform, filter;
  transition-duration: 160ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

.settings-pop-enter-from,
.settings-pop-leave-to {
  opacity: 0;
  transform: scale(0.25);
  filter: blur(4px);
}
</style>
