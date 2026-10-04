import formCreate, { type Api, type Options } from "@form-create/element-ui";
import type { DefineComponent } from "vue";
import {
  ElForm, ElFormItem, ElRow, ElCol, ElInput, ElInputNumber, ElSwitch,
  ElSelect, ElOption, ElCheckbox, ElCheckboxGroup, ElRadio, ElRadioGroup,
} from "element-plus";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/row/style/css";
import "element-plus/es/components/col/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/checkbox/style/css";
import "element-plus/es/components/checkbox-group/style/css";
import "element-plus/es/components/radio/style/css";
import "element-plus/es/components/radio-group/style/css";

for (const [name, component] of Object.entries({
  "el-form": ElForm, "el-form-item": ElFormItem, "el-row": ElRow, "el-col": ElCol,
  "el-input": ElInput, "el-input-number": ElInputNumber, "el-switch": ElSwitch,
  "el-select": ElSelect, "el-option": ElOption, "el-checkbox": ElCheckbox,
  "el-checkbox-group": ElCheckboxGroup, "el-radio": ElRadio, "el-radio-group": ElRadioGroup,
})) formCreate.component(name, component);

// ACT: 库的类型把默认导出声明成工具函数，运行时它同时是表单组件（含 props/setup/render）。
// 模板使用这个带 props 类型的别名；库修正类型后可直接改回 formCreate。
export const formCreateForm = formCreate as unknown as DefineComponent<{
  rule: ReturnType<typeof formCreate.copyRules>;
  option?: Options;
  modelValue?: Record<string, unknown>;
  api?: Api;
}>;

export type { Api, Options, Rule } from "@form-create/element-ui";
export default formCreate;
