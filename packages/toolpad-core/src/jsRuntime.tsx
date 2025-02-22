import {
  BindableAttrValue,
  BindingEvaluationResult,
  EnvAttrValue,
  JsExpressionAttrValue,
  JsRuntime,
} from './types.js';

export const TOOLPAD_LOADING_MARKER = '__TOOLPAD_LOADING_MARKER__';

export function evaluateBindable<V>(
  ctx: JsRuntime,
  bindable: BindableAttrValue<V> | null,
  globalScope: Record<string, unknown>,
): BindingEvaluationResult {
  if ((bindable as JsExpressionAttrValue)?.$$jsExpression) {
    return ctx.evaluateExpression((bindable as JsExpressionAttrValue).$$jsExpression, globalScope);
  }

  if ((bindable as EnvAttrValue)?.$$env) {
    return { value: process.env[(bindable as EnvAttrValue).$$env] };
  }

  if (bindable) {
    return { value: bindable };
  }

  return { value: undefined };
}
