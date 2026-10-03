import { ref } from "vue";

/** The wizard is mounted once in App.vue; anything (home banner, header button, settings panels) opens it through here. */
export const connectModelVisible = ref(false);
export const connectModelFocus = ref<"text" | "media" | undefined>();
export function openConnectModel(focus?: "text" | "media") {
  connectModelFocus.value = focus;
  connectModelVisible.value = true;
}
