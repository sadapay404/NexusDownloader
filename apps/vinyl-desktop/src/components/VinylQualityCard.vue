<script setup lang="ts">
import { extendedTiers, primaryTiers, tierLabel } from "@/utils/vinylSelection";

defineProps<{
  offered: ReadonlySet<number>;
  selected: number | null;
  expanded: boolean;
  automatic: boolean;
  seconds: number | null;
  paused: boolean;
  checking: boolean;
  submitting: boolean;
  hasDestination: boolean;
}>();

const emit = defineEmits<{
  choose: [tier: number];
  more: [];
  continue: [];
  download: [];
  cancel: [];
  advanced: [];
}>();
</script>

<template>
  <section class="quality-deck" aria-labelledby="vinyl-quality-heading">
    <div class="deck-legend">
      <span>
        <b>{{ $t("vinyl.sideB") }}</b>
        <i></i>
        {{ $t("common.download") }}
      </span>
      <span v-if="automatic" class="deck-default">{{ $t("vinyl.qualityDefault") }}</span>
    </div>
    <div class="deck-head">
      <h2 id="vinyl-quality-heading">{{ $t("vinyl.quality") }}</h2>
      <button type="button" class="deck-link" @click="emit('advanced')">
        {{ $t("vinyl.advanced") }}
        <icon-mdi-arrow-down aria-hidden="true" />
      </button>
    </div>
    <div class="tier-grid tier-grid-primary">
      <button
        v-for="tier in primaryTiers"
        :key="tier"
        type="button"
        class="tier-button"
        :aria-pressed="selected === tier"
        :aria-disabled="!offered.has(tier) || submitting"
        :title="
          offered.has(tier) ? undefined : $t('vinyl.notOffered', { quality: tierLabel(tier) })
        "
        @click="emit('choose', tier)"
      >
        {{ tierLabel(tier) }}
      </button>
      <button
        type="button"
        class="tier-button more-button"
        :aria-expanded="expanded"
        aria-controls="vinyl-more-qualities"
        @click="emit('more')"
      >
        {{ $t("vinyl.more") }}
        <icon-mdi-chevron-down aria-hidden="true" />
      </button>
    </div>
    <n-collapse-transition id="vinyl-more-qualities" :show="expanded">
      <div class="tier-grid tier-grid-more">
        <button
          v-for="tier in extendedTiers"
          :key="tier"
          type="button"
          class="tier-button"
          :aria-pressed="selected === tier"
          :aria-disabled="!offered.has(tier) || submitting"
          :title="
            offered.has(tier) ? undefined : $t('vinyl.notOffered', { quality: tierLabel(tier) })
          "
          @click="emit('choose', tier)"
        >
          {{ tierLabel(tier) }}
        </button>
      </div>
    </n-collapse-transition>
    <p v-if="!offered.has(1080)" class="deck-note">{{ $t("vinyl.noDefault") }}</p>
    <div class="deck-actions">
      <template v-if="seconds !== null">
        <div class="deck-countdown" role="status">
          <VinylDisc small :spinning="!paused" />
          {{ paused ? $t("vinyl.paused") : $t("vinyl.continuing", { seconds }) }}
        </div>
        <n-button size="small" secondary @click="emit('cancel')">
          {{ $t("vinyl.cancelCountdown") }}
        </n-button>
      </template>
      <template v-else>
        <n-button
          type="primary"
          strong
          :loading="checking || submitting"
          :disabled="checking || submitting"
          @click="automatic ? emit('continue') : emit('download')"
        >
          {{
            automatic
              ? $t("vinyl.continue")
              : selected
                ? $t("vinyl.manual", { quality: tierLabel(selected) })
                : $t("vinyl.manualFormat")
          }}
          <template #icon><icon-mdi-arrow-right /></template>
        </n-button>
        <span v-if="checking" class="deck-note" role="status">{{ $t("vinyl.checkingTools") }}</span>
        <span v-else-if="!hasDestination" class="deck-note">{{ $t("vinyl.saveFirst") }}</span>
        <span v-else-if="automatic" class="deck-note">{{ $t("vinyl.continueHint") }}</span>
      </template>
    </div>
  </section>
</template>

<style scoped>
.quality-deck {
  padding: 15px 16px;
  border: 1px solid var(--vinyl-keyline);
  border-radius: 14px;
  background: var(--vinyl-panel);
  box-shadow:
    0 12px 28px #0002,
    inset 0 1px #e0c98312;
  backdrop-filter: blur(12px);
}
.deck-legend,
.deck-head,
.deck-actions,
.deck-countdown {
  display: flex;
  align-items: center;
  gap: 10px;
}
.deck-legend,
.deck-head {
  justify-content: space-between;
}
.deck-legend {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--vinyl-keyline);
  font:
    10px/1.4 ui-monospace,
    Consolas,
    monospace;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--vinyl-muted);
}
.deck-legend span {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}
.deck-legend b,
.deck-legend .deck-default {
  color: var(--vinyl-accent);
  font-weight: 500;
}
.deck-legend i {
  display: inline-block;
  width: 15px;
  height: 1px;
  background: var(--vinyl-keyline);
}
.deck-head {
  margin: 10px 0 9px;
}
.deck-head h2 {
  font-size: 18px;
  font-weight: 660;
  letter-spacing: -0.022em;
}
.deck-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  color: var(--vinyl-accent);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.deck-link:hover {
  text-decoration: underline;
}
.tier-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}
.tier-grid-more {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  padding-top: 8px;
}
.tier-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 37px;
  border: 1px solid var(--vinyl-keyline);
  border-radius: 7px;
  color: inherit;
  background: #d4af370a;
  font-family: inherit;
  line-height: 1.15;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  transition:
    color 150ms,
    border-color 150ms,
    background 150ms;
}
.tier-button:hover,
.tier-button[aria-pressed="true"],
.tier-button[aria-expanded="true"] {
  border-color: var(--vinyl-accent);
  color: var(--vinyl-accent);
  background: var(--vinyl-selection);
}
.tier-button[aria-disabled="true"] {
  opacity: 0.43;
  cursor: not-allowed;
}
.tier-button[aria-disabled="true"]:hover {
  background: #d4af370a;
  border-color: var(--vinyl-keyline);
  color: inherit;
}
.tier-button:focus-visible,
.deck-link:focus-visible {
  outline: 2px solid var(--vinyl-accent);
  outline-offset: 2px;
}
.more-button svg {
  transition: transform 180ms;
}
.more-button[aria-expanded="true"] svg {
  transform: rotate(180deg);
}
.deck-actions {
  margin-top: 12px;
  flex-wrap: wrap;
}
.deck-countdown {
  color: var(--vinyl-accent);
  font-size: 14px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.deck-note {
  color: var(--vinyl-muted);
  font-size: 12px;
}
p.deck-note {
  margin-top: 9px;
}
</style>
