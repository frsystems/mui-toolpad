import { BindableAttrValue, ExecFetchResult, PrimitiveValueType } from '@mui/toolpad-core';

export interface LocalConnectionParams {}

export interface LocalQuery {
  function?: string;
}

export type LocalParams = {
  readonly searchParams: [string, BindableAttrValue<any>][];
  readonly body?: Body;
};

export type LocalPrivateQuery =
  | {
      kind: 'debugExec';
      query: LocalQuery;
      params: Record<string, any>;
    }
  | {
      kind: 'introspection';
    }
  | {
      kind: 'openEditor';
    };

export interface FetchResult extends ExecFetchResult<any> {
  data: any;
}

export interface IntrospectedFunction {
  name: string;
  file: string;
  parameters: Record<string, PrimitiveValueType>;
}

export type IntrospectionResult = {
  functions: Record<string, IntrospectedFunction>;
};
