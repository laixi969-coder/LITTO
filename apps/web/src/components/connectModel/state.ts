import { ref } from "vue";
import { canManageModels, isAuthDisabled } from "@/lib/session";
import router from "@/router";

/** The wizard is mounted once in App.vue; anything (home banner, header button, settings panels) opens it through here. */
export const connectModelVisible = ref(false);
export const connectModelFocus = ref<"text" | "media" | undefined>();
export async function openConnectModel(focus?: "text" | "media") {
  if (!canManageModels()) return;
  if (!isAuthDisabled() && router.currentRoute.value.path !== "/admin") await router.push({ path: "/admin", query: { tab: "api" } });
  connectModelFocus.value = focus;
  connectModelVisible.value = true;
}
