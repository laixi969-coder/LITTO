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
      path: "/pricing",
      component: () => import("@/pages/pricing/index.vue"),
    },
    {
      path: "/admin",
      component: () => import("@/pages/admin/index.vue"),
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
// The pricing preview is public. Workspace and administration still require a session.
router.beforeEach(async (to) => {
  if (to.path === "/pricing") return true;
  const me = getMe() ?? await loadMe();
  if (isAuthDisabled()) return ["/login", "/admin"].includes(to.path) ? "/home" : true;
  if (to.path === "/login") return me ? "/home" : true;
  if (me && to.path === "/admin" && (!me.user.isAdmin || me.desktopShare)) return "/home";
  return me ? true : "/login";
});
export default router;
