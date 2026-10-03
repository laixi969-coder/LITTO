import { createRouter, createWebHashHistory } from "vue-router";
import { useHelloStore } from "@/stores/hello";
import { getMe, isAuthDisabled, loadMe } from "@/lib/session";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/home",
    },
    {
      path: "/login",
      component: () => import("@/pages/login/index.vue"),
    },
    {
      path: "/hello",
      beforeEnter: async () => await useHelloStore().load() ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace",
      component: () => import("@/pages/workspace/index.vue"),
    },
  ],
});
// Accounts: everything except /login needs a session (unless the server runs in single-user mode).
router.beforeEach(async (to) => {
  const me = getMe() ?? await loadMe();
  if (isAuthDisabled()) return to.path === "/login" ? "/home" : true;
  if (to.path === "/login") return me ? "/home" : true;
  return me ? true : "/login";
});
export default router;
