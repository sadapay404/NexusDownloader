<script setup lang="ts">
const emit = defineEmits<{ visibilityChange: [visible: boolean] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
let startedOnBackdrop = false;

const rows = [
  ["Who Am I", "Sheikh Arsalan"],
  ["Created For", "Digital Sheikh Nexus Academy"],
  ["Languages Used", "Rust, TypeScript, HTML, CSS"],
  ["Licence", "Proprietary — All Rights Reserved"],
  ["Copyright", "© 2026 Sheikh Arsalan & Nexus Academy"],
];

function showCredits() {
  if (!dialog.value || dialog.value.open) return;
  dialog.value.showModal();
  emit("visibilityChange", true);
}

function isBackdrop(event: MouseEvent) {
  if (!dialog.value || event.target !== dialog.value) return false;
  const { left, right, top, bottom } = dialog.value.getBoundingClientRect();
  return (
    event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom
  );
}

function onPointerDown(event: PointerEvent) {
  startedOnBackdrop = isBackdrop(event);
}

function onClick(event: MouseEvent) {
  if (startedOnBackdrop && isBackdrop(event)) dialog.value?.close();
  startedOnBackdrop = false;
}

function onClose() {
  startedOnBackdrop = false;
  emit("visibilityChange", false);
  trigger.value?.focus();
}
</script>

<template>
  <footer class="runout-credit">
    Proudly Created by
    <strong>
      <button
        ref="trigger"
        type="button"
        class="credits-trigger"
        aria-haspopup="dialog"
        aria-controls="vinyl-credits"
        @click="showCredits"
      >
        <u>Sheikh Arsalan</u>
      </button>
    </strong>
    for <strong>Digital Sheikh Nexus Academy</strong>
  </footer>
  <dialog
    id="vinyl-credits"
    ref="dialog"
    class="credits-dialog"
    aria-labelledby="vinyl-credits-title"
    @pointerdown="onPointerDown"
    @click="onClick"
    @close="onClose"
  >
    <header class="credits-header">
      <h2 id="vinyl-credits-title">Credits</h2>
      <form method="dialog">
        <button class="credits-close" type="submit">Close</button>
      </form>
    </header>
    <dl>
      <div v-for="[label, value] in rows" :key="label" class="credits-row">
        <dt>{{ label }}</dt>
        <dd>{{ value }}</dd>
      </div>
    </dl>
  </dialog>
</template>

<style scoped lang="scss">
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

.credits-trigger {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-underline-offset: 2px;
}

.credits-trigger:hover u {
  text-decoration-thickness: 2px;
}

.credits-trigger:focus-visible,
.credits-close:focus-visible {
  outline: 2px solid var(--vinyl-accent);
  outline-offset: 3px;
  border-radius: 4px;
}

.credits-dialog {
  position: fixed;
  inset: 0;
  width: min(440px, calc(100% - 32px));
  height: fit-content;
  max-width: none;
  max-height: calc(100% - 32px);
  margin: auto;
  padding: 22px clamp(14px, 5vw, 24px);
  overflow: auto;
  overscroll-behavior: contain;
  border: 0;
  border-radius: 16px;
  background: #0d120e;
  color: #f0f5f1;
  box-shadow: 0 24px 60px #0006;
  font-size: 13px;
  line-height: 1.4;
}

.credits-dialog::backdrop {
  background: #070e0aa6;
  backdrop-filter: blur(6px);
}

.credits-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 7px;

  h2 {
    font-size: 18px;
    font-weight: 700;
  }
}

.credits-close {
  min-height: 32px;
  padding: 4px 11px;
  border: 1px solid #25322a;
  border-radius: 8px;
  background: #050505;
  color: inherit;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.credits-close:hover {
  background: #19251c;
}

.credits-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding-block: 10px;
  border-bottom: 1px solid #1b201c;

  dt {
    font-weight: 600;
  }

  dd {
    text-align: end;
    font-weight: 600;
    white-space: nowrap;
  }
}

@media (max-width: 420px) {
  .credits-dialog {
    font-size: 12px;
  }

  .credits-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
