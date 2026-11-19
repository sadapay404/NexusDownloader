<script setup lang="ts">
defineProps<{ spinning?: boolean; small?: boolean }>();
</script>

<template>
  <span class="vinyl-disc" :class="{ spinning, small }" aria-hidden="true">
    <span class="vinyl-disc-label"><i></i></span>
  </span>
</template>

<style scoped>
.vinyl-disc {
  position: relative;
  width: 58px;
  aspect-ratio: 1;
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 50%;
  border: 1px solid #786442;
  background:
    conic-gradient(
      from 55deg,
      #ddd1b52b,
      transparent 24%,
      #ddd1b511 53%,
      transparent 76%,
      #ddd1b52b
    ),
    repeating-radial-gradient(circle, #1c1a18 0 2px, #31302d 2.5px 3px, #201e1a 3.5px 4.5px);
  box-shadow:
    0 8px 22px #0005,
    inset 0 0 0 3px #0e0d0c;
}
.vinyl-disc.small {
  width: 33px;
}
.vinyl-disc-label {
  display: grid;
  place-items: center;
  width: 37%;
  aspect-ratio: 1;
  border-radius: 50%;
  border: 1px solid #ead191;
  background: linear-gradient(145deg, #ebcc83, #ad7e3c 80%);
}
.vinyl-disc-label i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #201910;
}
.small .vinyl-disc-label i {
  width: 2px;
  height: 2px;
}
.vinyl-disc.spinning {
  animation: rotate-record 3.5s linear infinite;
}
@keyframes rotate-record {
  to {
    transform: rotate(1turn);
  }
}
@media (prefers-reduced-motion: reduce) {
  .vinyl-disc.spinning {
    animation: none;
  }
}
</style>
