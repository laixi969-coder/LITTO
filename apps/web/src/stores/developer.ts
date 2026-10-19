import { defineStore } from "pinia";

export const useDeveloperStore = defineStore("developer", {
  state: () => ({ developerConfirmed: false }),
  persist: { key: "milimili.developer", storage: localStorage },
});
