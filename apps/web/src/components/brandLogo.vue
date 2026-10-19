<template>
  <span class="brandLogo" :class="{ fixedDark: theme === 'dark', fixedLight: theme === 'light' }" role="img" aria-label="MILI MILI 米粒米粒">
    <img class="lightLogo" :src="logoLight" alt="" />
    <img class="darkLogo" :src="logoDark" alt="" />
  </span>
</template>

<script setup lang="ts">
import logoLight from "@toonflow/assets/logoLight.png";
import logoDark from "@toonflow/assets/logoDark.png";

withDefaults(defineProps<{ theme?: "auto" | "light" | "dark" }>(), { theme: "auto" });
</script>

<style lang="scss" scoped>
.brandLogo {
  display: inline-block;
  flex-shrink: 0;
  width: 144px;
  max-width: 100%;
  vertical-align: middle;

  img {
    display: block;
    width: 100%;
    height: auto;
  }

  .darkLogo { display: none; }

  &:not(.fixedLight):not(.fixedDark) {
    html.dark & {
      .lightLogo { display: none; }
      .darkLogo { display: block; }
    }
  }

  &.fixedDark {
    .lightLogo { display: none; }
    .darkLogo { display: block; }
  }
}
</style>
