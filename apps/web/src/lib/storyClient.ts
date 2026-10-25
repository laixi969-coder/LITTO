import axios from "axios";
import { registerApiLanguage } from "@/lib/i18n";
import { storyProjectSchema, type StoryAction } from "@toonflow/tool-scene-list/storyProject";

const client = axios.create({ baseURL: "/api/story", headers: { "x-toonflow-workspace": "1" } });
// 独立实例不会继承全局拦截器，必须单独注册，否则写请求缺 x-milimili-csrf，被来源校验 403。
registerApiLanguage(client);
export async function readStory(directory: string) {
  const { productionContext, ...project } = (await client.get("/get", { params: { directory } })).data.data;
  return storyProjectSchema.parse(project);
}
export async function updateStory(directory: string, expectedVersion: number, action: StoryAction) {
  return storyProjectSchema.parse((await client.post("/apply", { directory, expectedVersion, action })).data.data);
}

export async function readStoryProductionContext(directory: string) {
  return (await client.get("/get", { params: { directory } })).data.data.productionContext;
}
