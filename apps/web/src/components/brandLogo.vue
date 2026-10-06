<template>
  <span class="brandLogo" :class="{ fixedDark: theme === 'dark', fixedLight: theme === 'light' }" role="img" aria-label="LITTO 里头">
    <svg class="lightLogo" viewBox="290 102 959 797" aria-hidden="true" focusable="false">
      <image :href="logoLight" width="1536" height="1024" />
    </svg>
    <svg class="darkLogo" viewBox="303 124 940 735" aria-hidden="true" focusable="false">
      <image :href="logoDark" width="1536" height="1024" />
    </svg>
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
  height: 120px;
  max-width: 100%;
  vertical-align: middle;


  svg {
    display: block;
    width: 100%;
    height: 100%;
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
