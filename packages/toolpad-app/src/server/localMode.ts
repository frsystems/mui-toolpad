import * as yaml from 'yaml';
import * as path from 'path';
import * as fs from 'fs/promises';
import invariant from 'invariant';
import openEditor from 'open-editor';
import chalk from 'chalk';
import { BindableAttrValue, NodeId, PropBindableAttrValue } from '@mui/toolpad-core';
import { fromZodError } from 'zod-validation-error';
import { glob } from 'glob';
import * as chokidar from 'chokidar';
import { debounce } from 'lodash-es';
import { Emitter } from '@mui/toolpad-utils/events';
import { errorFrom } from '@mui/toolpad-utils/errors';
import { filterValues, hasOwnProperty, mapValues } from '@mui/toolpad-utils/collections';
import { execa } from 'execa';
import {
  writeFileRecursive,
  readMaybeFile,
  readMaybeDir,
  updateYamlFile,
  fileExists,
} from '@mui/toolpad-utils/fs';
import config from '../config';
import * as appDom from '../appDom';
import * as v7LegacyDom from '../appDom/migrations/types/v7Legacy';
import { migrateUp } from '../appDom/migrations';
import insecureHash from '../utils/insecureHash';
import {
  Page,
  Query,
  ElementType,
  pageSchema,
  Template,
  BindableProp,
  LocalQueryConfig,
  FetchQueryConfig,
  QueryConfig,
  FetchBody,
  ResponseType,
  Theme,
  themeSchema,
  API_VERSION,
} from './schema';
import { format } from '../utils/prettier';
import {
  Body as AppDomFetchBody,
  FetchQuery,
  ResponseType as AppDomRestResponseType,
} from '../toolpadDataSources/rest/types';
import { LocalQuery } from '../toolpadDataSources/local/types';
import { ProjectEvents, ToolpadProjectOptions } from '../types';
import { Awaitable } from '../utils/types';
import EnvManager from './EnvManager';
import FunctionsManager from './FunctionsManager';

export function getUserProjectRoot(): string {
  const { projectDir } = config;
  invariant(projectDir, 'Toolpad in local mode must have a project directory defined');
  return projectDir;
}

function getToolpadFolder(root: string): string {
  return path.join(root, './toolpad');
}

function getThemeFile(root: string): string {
  return path.join(getToolpadFolder(root), './theme.yml');
}

function getComponentsFolder(root: string): string {
  const toolpadFolder = getToolpadFolder(root);
  return path.join(toolpadFolder, './components');
}

function getPagesFolder(root: string): string {
  const toolpadFolder = getToolpadFolder(root);
  return path.join(toolpadFolder, './pages');
}

function getPageFolder(root: string, name: string): string {
  const pagesFolder = getPagesFolder(root);
  const pageFolder = path.resolve(pagesFolder, name);
  return pageFolder;
}

function getPageFile(root: string, name: string): string {
  const pageFolder = getPageFolder(root, name);
  const pageFileName = path.resolve(pageFolder, 'page.yml');
  return pageFileName;
}

function getComponentFilePath(componentsFolder: string, componentName: string): string {
  return path.join(componentsFolder, `${componentName}.tsx`);
}

export function getOutputFolder(root: string) {
  return path.join(getToolpadFolder(root), '.generated');
}

export function getAppOutputFolder(root: string) {
  return path.join(getOutputFolder(root), 'app');
}

export async function getConfigFilePath(root: string) {
  const yamlFilePath = path.join(root, './toolpad.yaml');
  const ymlFilePath = path.join(root, './toolpad.yml');

  if (await fileExists(yamlFilePath)) {
    return yamlFilePath;
  }

  if (await fileExists(ymlFilePath)) {
    return ymlFilePath;
  }

  return yamlFilePath;
}

type ComponentsContent = Record<string, { code: string }>;

export async function getComponents(root: string) {
  const componentsFolder = getComponentsFolder(root);
  const entries = (await readMaybeDir(componentsFolder)) || [];
  const result = entries.map((entry) => {
    if (entry.isFile()) {
      const fileName = entry.name;
      const componentName = entry.name.replace(/\.tsx$/, '');
      const filePath = path.resolve(componentsFolder, fileName);
      return { name: componentName, path: filePath };
    }
    return null;
  });
  return result.filter(Boolean);
}

async function loadCodeComponentsFromFiles(root: string): Promise<ComponentsContent> {
  const components = await getComponents(root);
  const resultEntries = await Promise.all(
    components.map(async (component): Promise<[string, { code: string }]> => {
      const content = await fs.readFile(component.path, { encoding: 'utf-8' });
      return [component.name, { code: content }];
    }),
  );

  return Object.fromEntries(resultEntries);
}

async function loadPagesFromFiles(root: string): Promise<PagesContent> {
  const pagesFolder = getPagesFolder(root);
  const entries = (await readMaybeDir(pagesFolder)) || [];
  const resultEntries = await Promise.all(
    entries.map(async (entry): Promise<[string, Page] | null> => {
      if (entry.isDirectory()) {
        const pageName = entry.name;
        const filePath = path.resolve(pagesFolder, pageName, './page.yml');
        const content = await readMaybeFile(filePath);
        if (!content) {
          return null;
        }
        let parsedFile: Page | undefined;
        try {
          parsedFile = yaml.parse(content);
        } catch (rawError) {
          const error = errorFrom(rawError);

          console.error(
            `${chalk.red('error')} - Failed to read page ${chalk.cyan(pageName)}. ${error.message}`,
          );

          return null;
        }

        const result = pageSchema.safeParse(parsedFile);
        if (result.success) {
          return [pageName, result.data];
        }

        console.error(
          `${chalk.red('error')} - Failed to read page ${chalk.cyan(pageName)}. ${fromZodError(
            result.error,
          )}`,
        );

        return null;
      }

      return null;
    }),
  );

  return Object.fromEntries(resultEntries.filter(Boolean));
}

async function loadThemeFromFile(root: string): Promise<Theme | null> {
  const themeFilePath = getThemeFile(root);
  const content = await readMaybeFile(themeFilePath);
  if (content) {
    return themeSchema.parse(yaml.parse(content));
  }
  return null;
}

function createDefaultCodeComponent(name: string): string {
  const componentId = name.replace(/\s/g, '');
  const propTypeId = `${componentId}Props`;
  return format(`
    import * as React from 'react';
    import { Typography } from '@mui/material';
    import { createComponent } from '@mui/toolpad/browser';
    
    export interface ${propTypeId} {
      msg: string;
    }
    
    function ${componentId}({ msg }: ${propTypeId}) {
      return (
        <Typography>{msg}</Typography>
      );
    }

    export default createComponent(${componentId}, {
      argTypes: {
        msg: {
          type: "string",
          default: "Hello world!"
        },
      },
    });    
  `);
}

export async function createComponent(name: string) {
  const root = getUserProjectRoot();
  const componentsFolder = getComponentsFolder(root);
  const filePath = getComponentFilePath(componentsFolder, name);
  const content = createDefaultCodeComponent(name);
  await writeFileRecursive(filePath, content, { encoding: 'utf-8' });
}

export async function deletePage(name: string) {
  const root = getUserProjectRoot();
  const pageFolder = getPageFolder(root, name);
  await fs.rm(pageFolder, { force: true, recursive: true });
}

class Lock {
  pending: Promise<any> | null = null;

  async use<T = void>(doWork: () => Promise<T>): Promise<T> {
    try {
      this.pending = Promise.resolve(this.pending).then(() => doWork());
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
}

const configFileLock = new Lock();

async function loadConfigFileFrom(
  configFilePath: string,
): Promise<appDom.AppDom | v7LegacyDom.AppDom | null> {
  // Using a lock to avoid read during write which may result in reading truncated file content
  const configContent = await configFileLock.use(() => readMaybeFile(configFilePath));

  if (!configContent) {
    return null;
  }

  const parsedConfig = yaml.parse(configContent);
  invariant(parsedConfig, 'Invalid Toolpad config');
  return parsedConfig;
}

async function loadConfigFile(root: string): Promise<appDom.AppDom | v7LegacyDom.AppDom | null> {
  const configFilePath = await getConfigFilePath(root);
  const dom = await loadConfigFileFrom(configFilePath);
  return dom;
}

const DEFAULT_GENERATED_GITIGNORE_FILE_CONTENT = `.generated
`;

async function initGitignore(root: string) {
  const projectFolder = getToolpadFolder(root);
  const generatedGitignorePath = path.resolve(projectFolder, '.gitignore');
  if (!(await fileExists(generatedGitignorePath))) {
    // eslint-disable-next-line no-console
    console.log(`${chalk.blue('info')}  - Initializing .gitignore file`);
    await writeFileRecursive(generatedGitignorePath, DEFAULT_GENERATED_GITIGNORE_FILE_CONTENT, {
      encoding: 'utf-8',
    });
  }
}

async function writeCodeComponentsToFiles(
  componentsFolder: string,
  components: ComponentsContent,
): Promise<void> {
  await Promise.all(
    Object.entries(components).map(async ([componentName, content]) => {
      const filePath = getComponentFilePath(componentsFolder, componentName);
      await writeFileRecursive(filePath, content.code, { encoding: 'utf-8' });
    }),
  );
}

function mergeComponentsContentIntoDom(
  dom: appDom.AppDom,
  componentsContent: ComponentsContent,
): appDom.AppDom {
  const rootNode = appDom.getApp(dom);
  const { codeComponents: codeComponentNodes = [] } = appDom.getChildNodes(dom, rootNode);
  const names = new Set([
    ...Object.keys(componentsContent),
    ...codeComponentNodes.map((node) => node.name),
  ]);

  for (const name of names) {
    const content: { code: string } | undefined = componentsContent[name];
    const codeComponentNode = codeComponentNodes.find((node) => node.name === name);
    if (content) {
      if (codeComponentNode) {
        dom = appDom.setNodeNamespacedProp(
          dom,
          codeComponentNode,
          'attributes',
          'code',
          content.code,
        );
      } else {
        const newNode = appDom.createNode(dom, 'codeComponent', {
          name,
          attributes: {
            code: content.code,
          },
        });
        dom = appDom.addNode(dom, newNode, rootNode, 'codeComponents');
      }
    } else if (codeComponentNode) {
      dom = appDom.removeNode(dom, codeComponentNode.id);
    }
  }

  return dom;
}

function mergeThemeIntoAppDom(dom: appDom.AppDom, themeFile: Theme): appDom.AppDom {
  const themeFileSpec = themeFile.spec;
  const app = appDom.getApp(dom);
  dom = appDom.addNode(
    dom,
    appDom.createNode(dom, 'theme', {
      theme: themeFileSpec,
      attributes: {},
    }),
    app,
    'themes',
  );
  return dom;
}

function stringOnly(maybeString: unknown): string | undefined {
  return typeof maybeString === 'string' ? maybeString : undefined;
}

function expandChildren(children: appDom.ElementNode[], dom: appDom.AppDom): ElementType[];
function expandChildren(children: appDom.QueryNode[], dom: appDom.AppDom): Query[];
function expandChildren<N extends appDom.AppDomNode>(
  children: N[],
  dom: appDom.AppDom,
): (Query | ElementType)[];
function expandChildren<N extends appDom.AppDomNode>(children: N[], dom: appDom.AppDom) {
  return (
    children
      .sort((child1, child2) => {
        invariant(
          child1.parentIndex && child2.parentIndex,
          'Nodes are not children of another node',
        );
        return appDom.compareFractionalIndex(child1.parentIndex, child2.parentIndex);
      })
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      .map((child) => expandFromDom(child, dom))
  );
}

function undefinedWhenEmpty<O extends object | any[]>(obj?: O): O | undefined {
  if (!obj || Object.values(obj).every((property) => property === undefined)) {
    return undefined;
  }
  return obj;
}

function createPageFileQueryFromDomQuery(
  dataSource: string,
  query: FetchQuery | LocalQuery | undefined,
): QueryConfig {
  switch (dataSource) {
    case 'rest': {
      if (!query) {
        return { kind: 'rest' };
      }
      query = query as FetchQuery;

      let body: FetchBody | undefined;

      if (query.body) {
        switch (query.body.kind) {
          case 'raw': {
            body = {
              kind: 'raw',
              content: query.body.content as PropBindableAttrValue<string>,
              contentType: query.body.contentType,
            };
            break;
          }
          case 'urlEncoded': {
            body = {
              kind: 'urlEncoded',
              content: query.body.content.map(([name, value]) => ({
                name,
                value: value as PropBindableAttrValue<string>,
              })),
            };
            break;
          }
          default:
            throw new Error(`Unrecognized body kind "${(query.body as any).kind}"`);
        }
      }

      let response: ResponseType | undefined;

      if (query.response) {
        switch (query.response.kind) {
          case 'csv': {
            response = { kind: 'csv', headers: query.response.headers };
            break;
          }
          case 'json': {
            response = { kind: 'json' };
            break;
          }
          case 'xml': {
            response = { kind: 'xml' };
            break;
          }
          case 'raw': {
            response = { kind: 'raw' };
            break;
          }
          default:
            throw new Error(`Unrecognized response kind "${(query.response as any).kind}"`);
        }
      }

      return {
        kind: 'rest',
        url: query.url as PropBindableAttrValue<string>,
        searchParams: query.searchParams?.map(([name, value]) => ({
          name,
          value: value as PropBindableAttrValue<string>,
        })),
        headers: query.headers.map(([name, value]) => ({
          name,
          value: value as PropBindableAttrValue<string>,
        })),
        body,
        method: query.method,
        response,
        transform: query.transform,
        transformEnabled: query.transformEnabled,
      } satisfies FetchQueryConfig;
    }
    case 'local':
      if (!query) {
        return { kind: 'local' };
      }

      query = query as LocalQuery;
      return {
        function: query.function,
        kind: 'local',
      } satisfies LocalQueryConfig;
    default:
      throw new Error(`Unsupported dataSource "${dataSource}"`);
  }
}

function expandFromDom(node: appDom.ElementNode, dom: appDom.AppDom): ElementType;
function expandFromDom(node: appDom.QueryNode, dom: appDom.AppDom): Query;
function expandFromDom(node: appDom.PageNode, dom: appDom.AppDom): Page;
function expandFromDom<N extends appDom.AppDomNode>(
  node: N,
  dom: appDom.AppDom,
): Page | Query | ElementType;
function expandFromDom<N extends appDom.AppDomNode>(
  node: N,
  dom: appDom.AppDom,
): Page | Query | ElementType {
  if (appDom.isPage(node)) {
    const children = appDom.getChildNodes(dom, node);

    return {
      apiVersion: API_VERSION,
      kind: 'page',
      spec: {
        id: node.id,
        title: node.attributes.title,
        parameters: undefinedWhenEmpty(
          node.attributes.parameters?.map(([name, value]) => ({ name, value })) ?? [],
        ),
        content: undefinedWhenEmpty(expandChildren(children.children || [], dom)),
        queries: undefinedWhenEmpty(expandChildren(children.queries || [], dom)),
        display: node.attributes.display,
      },
    } satisfies Page;
  }

  if (appDom.isQuery(node)) {
    return {
      name: node.name,
      enabled: node.attributes.enabled as PropBindableAttrValue<boolean>,
      mode: node.attributes.mode,
      query: node.attributes.dataSource
        ? createPageFileQueryFromDomQuery(
            node.attributes.dataSource,
            node.attributes.query as FetchQuery | LocalQuery | undefined,
          )
        : undefined,
      parameters: undefinedWhenEmpty(node.params?.map(([name, value]) => ({ name, value }))),
      cacheTime: node.attributes.cacheTime,
      refetchInterval: node.attributes.refetchInterval,
      transform: node.attributes.transform,
      transformEnabled: node.attributes.transformEnabled,
    } satisfies Query;
  }

  if (appDom.isElement(node)) {
    const { children, ...templates } = appDom.getChildNodes(dom, node);

    const templateProps = mapValues(templates, (subtree) =>
      subtree
        ? {
            $$template: expandChildren(subtree, dom),
          }
        : undefined,
    );

    return {
      component: node.attributes.component,
      name: node.name,
      layout: undefinedWhenEmpty({
        columnSize: node.layout?.columnSize,
        horizontalAlign: stringOnly(node.layout?.horizontalAlign),
        verticalAlign: stringOnly(node.layout?.verticalAlign),
      }),
      props: undefinedWhenEmpty({ ...node.props, ...templateProps }),
      children: undefinedWhenEmpty(expandChildren(children || [], dom)),
    } satisfies ElementType;
  }

  throw new Error(`Unsupported node type "${node.type}"`);
}

function isTemplate(bindableProp?: BindableProp): bindableProp is Template {
  return !!(
    bindableProp &&
    typeof bindableProp === 'object' &&
    hasOwnProperty(bindableProp, '$$template')
  );
}

function mergeElementIntoDom(
  dom: appDom.AppDom,
  parent: appDom.ElementNode | appDom.PageNode,
  parentProp: string,
  elm: ElementType,
): appDom.AppDom {
  const plainProps = filterValues(elm.props ?? {}, (prop) => !isTemplate(prop)) as Record<
    string,
    Exclude<BindableProp, Template>
  >;

  const templateProps = filterValues(elm.props ?? {}, isTemplate) as Record<string, Template>;

  const elmNode = appDom.createElement(dom, elm.component, plainProps, elm.layout ?? {}, elm.name);

  dom = appDom.addNode(dom, elmNode, parent, parentProp as any);

  if (elm.children) {
    for (const child of elm.children) {
      dom = mergeElementIntoDom(dom, elmNode, 'children', child);
    }
  }

  for (const [propName, templateProp] of Object.entries(templateProps)) {
    for (const child of templateProp.$$template) {
      dom = mergeElementIntoDom(dom, elmNode, propName, child);
    }
  }

  return dom;
}

function createDomQueryFromPageFileQuery(query: QueryConfig): FetchQuery | LocalQuery {
  switch (query.kind) {
    case 'local':
      return {
        function: query.function,
      } satisfies LocalQuery;
    case 'rest': {
      let body: AppDomFetchBody | undefined;

      if (query.body) {
        switch (query.body.kind) {
          case 'raw': {
            body = {
              kind: 'raw',
              content: query.body.content,
              contentType: query.body.contentType,
            };
            break;
          }
          case 'urlEncoded': {
            body = {
              kind: 'urlEncoded',
              content: query.body.content.map(({ name, value }) => [
                name,
                value as PropBindableAttrValue<string>,
              ]),
            };
            break;
          }
          default:
            throw new Error(`Unrecognized body kind "${(query.body as any).kind}"`);
        }
      }

      let response: AppDomRestResponseType | undefined;

      if (query.response) {
        switch (query.response.kind) {
          case 'csv': {
            response = { kind: 'csv', headers: query.response.headers };
            break;
          }
          case 'json': {
            response = { kind: 'json' };
            break;
          }
          case 'xml': {
            response = { kind: 'xml' };
            break;
          }
          case 'raw': {
            response = { kind: 'raw' };
            break;
          }
          default:
            throw new Error(`Unrecognized response kind "${(query.response as any).kind}"`);
        }
      }

      return {
        url: query.url || undefined,
        headers: query.headers?.map(({ name, value }) => [name, value]) || [],
        method: query.method || 'GET',
        browser: false,
        transform: query.transform,
        transformEnabled: query.transformEnabled,
        searchParams: query.searchParams?.map(({ name, value }) => [name, value]) || [],
        body,
        response,
      } satisfies FetchQuery;
    }
    default:
      throw new Error(`Unrecognized query kind "${(query as any).kind}"`);
  }
}

function createPageDomFromPageFile(pageName: string, pageFile: Page): appDom.AppDom {
  const pageFileSpec = pageFile.spec;
  let fragment = appDom.createFragmentInternal(pageFileSpec.id as NodeId, 'page', {
    name: pageName,
    attributes: {
      title: pageFileSpec.title || '',
      parameters: pageFileSpec.parameters?.map(({ name, value }) => [name, value]) || [],
      display: pageFileSpec.display || undefined,
    },
  });

  const pageNode = appDom.getRoot(fragment);
  appDom.assertIsPage(pageNode);

  if (pageFileSpec.queries) {
    for (const query of pageFileSpec.queries) {
      if (query.query) {
        const queryNode = appDom.createNode(fragment, 'query', {
          name: query.name,
          attributes: {
            connectionId: null,
            dataSource: typeof query.query?.kind === 'string' ? query.query.kind : undefined,
            query: createDomQueryFromPageFileQuery(query.query),
            cacheTime: typeof query.cacheTime === 'number' ? query.cacheTime : undefined,
            enabled: query.enabled ?? undefined,
            mode: typeof query.mode === 'string' ? query.mode : undefined,
            transform: typeof query.transform === 'string' ? query.transform : undefined,
            refetchInterval:
              typeof query.refetchInterval === 'number' ? query.refetchInterval : undefined,
            transformEnabled: query.transformEnabled ?? undefined,
          },
          params: query.parameters?.map(
            ({ name, value }) => [name, value] satisfies [string, BindableAttrValue<any>],
          ),
        });
        fragment = appDom.addNode(fragment, queryNode, pageNode, 'queries');
      }
    }
  }

  if (pageFileSpec.content) {
    for (const child of pageFileSpec.content) {
      fragment = mergeElementIntoDom(fragment, pageNode, 'children', child);
    }
  }

  return fragment;
}

function mergePageIntoDom(dom: appDom.AppDom, pageName: string, pageFile: Page): appDom.AppDom {
  const appRoot = appDom.getRoot(dom);
  const pageFragment = createPageDomFromPageFile(pageName, pageFile);

  const newPageNode = appDom.getRoot(pageFragment);

  if (appDom.getMaybeNode(dom, newPageNode.id)) {
    dom = appDom.removeNode(dom, newPageNode.id);
  }

  dom = appDom.addFragment(dom, pageFragment, appRoot.id, 'pages');

  return dom;
}

function mergPagesIntoDom(dom: appDom.AppDom, pages: PagesContent): appDom.AppDom {
  for (const [name, page] of Object.entries(pages)) {
    dom = mergePageIntoDom(dom, name, page);
  }
  return dom;
}

type PagesContent = Record<string, Page>;

interface ExtractedPages {
  pages: PagesContent;
  dom: appDom.AppDom;
}

function extractPagesFromDom(dom: appDom.AppDom): ExtractedPages {
  const rootNode = appDom.getApp(dom);
  const { pages: pageNodes = [] } = appDom.getChildNodes(dom, rootNode);

  const pages: PagesContent = {};

  for (const pageNode of pageNodes) {
    pages[pageNode.name] = expandFromDom(pageNode, dom);
    dom = appDom.removeNode(dom, pageNode.id);
  }

  return { pages, dom };
}

async function writePagesToFiles(root: string, pages: PagesContent) {
  await Promise.all(
    Object.entries(pages).map(async ([name, page]) => {
      const pageFileName = getPageFile(root, name);
      await updateYamlFile(pageFileName, page);
    }),
  );
}

async function writeThemeFile(root: string, theme: Theme | null) {
  const themeFilePath = getThemeFile(root);
  if (theme) {
    await updateYamlFile(themeFilePath, theme);
  } else {
    await fs.rm(themeFilePath, { recursive: true, force: true });
  }
}

interface ExtractedComponents {
  components: ComponentsContent;
  dom: appDom.AppDom;
}

function extractComponentsContentFromDom(dom: appDom.AppDom): ExtractedComponents {
  const rootNode = appDom.getApp(dom);
  const { codeComponents: codeComponentNodes = [] } = appDom.getChildNodes(dom, rootNode);

  const components: ComponentsContent = {};

  for (const codeComponent of codeComponentNodes) {
    components[codeComponent.name] = { code: codeComponent.attributes.code };
    dom = appDom.removeNode(dom, codeComponent.id);
  }

  return { components, dom };
}

function extractThemeContentFromDom(dom: appDom.AppDom): Theme | null {
  const app = appDom.getApp(dom);
  const { themes = [] } = appDom.getChildNodes(dom, app);
  if (themes[0]?.theme) {
    return {
      apiVersion: API_VERSION,
      kind: 'theme',
      spec: {
        'palette.mode': appDom.fromConstPropValue(themes[0].theme['palette.mode']),
        'palette.primary.main': appDom.fromConstPropValue(themes[0].theme['palette.primary.main']),
        'palette.secondary.main': appDom.fromConstPropValue(
          themes[0].theme['palette.secondary.main'],
        ),
      },
    };
  }
  return null;
}

async function writeDomToDisk(dom: appDom.AppDom): Promise<void> {
  const root = getUserProjectRoot();
  const { pages: pagesContent } = extractPagesFromDom(dom);
  await Promise.all([writePagesToFiles(root, pagesContent)]);
}

const DEFAULT_EDITOR = 'code';

export async function findSupportedEditor(): Promise<string | null> {
  const maybeEditor = process.env.EDITOR ?? DEFAULT_EDITOR;
  if (!maybeEditor) {
    return null;
  }
  try {
    await execa('which', [maybeEditor]);
    return maybeEditor;
  } catch (err) {
    return null;
  }
}

let supportedEditorPromise: Promise<string | null>;

export async function getSupportedEditor(): Promise<string | null> {
  if (!supportedEditorPromise) {
    supportedEditorPromise = findSupportedEditor();
  }
  return supportedEditorPromise;
}

async function openCodeEditor(file: string): Promise<void> {
  const supportedEditor = await getSupportedEditor();
  if (!supportedEditor) {
    throw new Error(`No code editor found`);
  }
  const userProjectRoot = getUserProjectRoot();
  const fullPath = path.resolve(userProjectRoot, file);
  openEditor([fullPath, userProjectRoot], {
    editor: process.env.EDITOR ? undefined : DEFAULT_EDITOR,
  });
}

export async function openCodeComponentEditor(componentName: string): Promise<void> {
  const root = getUserProjectRoot();
  const componentsFolder = getComponentsFolder(root);
  const fullPath = getComponentFilePath(componentsFolder, componentName);
  await openCodeEditor(fullPath);
}

export type ProjectFolderEntry = {
  name: string;
  kind: 'query';
  filepath: string;
};

interface ToolpadProjectFolder {
  pages: Record<string, Page>;
  components: Record<string, { code: string }>;
  theme: Theme | null;
}

async function readProjectFolder(root: string): Promise<ToolpadProjectFolder> {
  const [componentsContent, pagesContent, theme] = await Promise.all([
    loadCodeComponentsFromFiles(root),
    loadPagesFromFiles(root),
    loadThemeFromFile(root),
  ]);

  return {
    pages: pagesContent,
    components: componentsContent,
    theme,
  };
}

async function writeProjectFolder(
  root: string,
  folder: ToolpadProjectFolder,
  writeComponents: boolean = false,
): Promise<void> {
  await writePagesToFiles(root, folder.pages);
  await writeThemeFile(root, folder.theme);
  if (writeComponents) {
    const componentsFolder = getComponentsFolder(root);
    await writeCodeComponentsToFiles(componentsFolder, folder.components);
  }
}

function projectFolderToAppDom(projectFolder: ToolpadProjectFolder): appDom.AppDom {
  let dom = appDom.createDom();
  dom = mergPagesIntoDom(dom, projectFolder.pages);
  dom = mergeComponentsContentIntoDom(dom, projectFolder.components);
  if (projectFolder.theme) {
    dom = mergeThemeIntoAppDom(dom, projectFolder.theme);
  }
  return dom;
}

function appDomToProjectFolder(dom: appDom.AppDom): ToolpadProjectFolder {
  const { pages } = extractPagesFromDom(dom);
  const { components } = extractComponentsContentFromDom(dom);
  const theme = extractThemeContentFromDom(dom);
  return { pages, components, theme };
}

async function loadProjectFolder(): Promise<ToolpadProjectFolder> {
  const root = getUserProjectRoot();
  return readProjectFolder(root);
}

export async function loadDomFromDisk(): Promise<appDom.AppDom> {
  const projectFolder = await loadProjectFolder();
  return projectFolderToAppDom(projectFolder);
}

async function migrateLegacyProject(root: string) {
  let dom = await loadConfigFile(root);
  if (!dom) {
    return;
  }
  const domVersion = dom.version ?? 0;
  if (domVersion > appDom.CURRENT_APPDOM_VERSION) {
    console.error(
      `${chalk.red(
        'error',
      )} - This project was created with a newer version of Toolpad, please upgrade your ${chalk.cyan(
        '@mui/toolpad',
      )} installation`,
    );
    process.exit(1);
  } else if (domVersion < appDom.CURRENT_APPDOM_VERSION) {
    // eslint-disable-next-line no-console
    console.log(
      `${chalk.blue(
        'info',
      )}  - This project was created by an older version of Toolpad. Upgrading...`,
    );

    dom = migrateUp(dom as v7LegacyDom.AppDom);
  }

  const projectFolder = appDomToProjectFolder(dom as appDom.AppDom);

  await writeProjectFolder(root, projectFolder, true);

  const configFilePath = await getConfigFilePath(root);
  await Promise.all([
    fs.rm(configFilePath, { recursive: true, force: true }),
    fs.rm(path.resolve(root, '.toolpad-generated'), { recursive: true, force: true }),
  ]);
}

function getDomFilePatterns(root: string) {
  return [
    path.resolve(root, './toolpad.yml'),
    path.resolve(root, './toolpad.yml'),
    path.resolve(root, './toolpad/pages/*/page.yml'),
    path.resolve(root, './toolpad/components/*.*'),
  ];
}

/**
 * Calculates a fingerprint from all files that influence the dom structure
 */
async function calculateDomFingerprint(root: string): Promise<number> {
  const files = await glob(getDomFilePatterns(root));

  const mtimes = await Promise.all(
    files.sort().map(async (file) => {
      const stats = await fs.stat(file);
      return [file, stats.mtimeMs];
    }),
  );

  return insecureHash(JSON.stringify(mtimes));
}

async function initToolpadFolder(root: string) {
  const projectFolder = await readProjectFolder(root);
  if (Object.keys(projectFolder.pages).length <= 0) {
    projectFolder.pages.page = {
      apiVersion: 'v1',
      kind: 'page',
      spec: {
        id: appDom.createId(),
        title: 'Default page',
      },
    };
    await writeProjectFolder(root, projectFolder);
  }

  await initGitignore(root);
}

function getCodeComponentsFingerprint(dom: appDom.AppDom) {
  const { codeComponents = [] } = appDom.getChildNodes(dom, appDom.getApp(dom));
  return codeComponents.map(({ name }) => name).join('|');
}

class ToolpadProject {
  root: string;

  events = new Emitter<ProjectEvents>();

  private domAndFingerprint: Awaitable<[appDom.AppDom, number]> | null = null;

  private domAndFingerprintLock = new Lock();

  options: ToolpadProjectOptions;

  private codeComponentsFingerprint: null | string = null;

  envManager: EnvManager;

  functionsManager: FunctionsManager;

  constructor(root: string, options: Partial<ToolpadProjectOptions>) {
    this.root = root;
    this.options = {
      dev: false,
      ...options,
    };

    this.envManager = new EnvManager(this);
    this.functionsManager = new FunctionsManager(this);

    this.initWatcher();
  }

  private initWatcher() {
    if (!this.options.dev) {
      return;
    }

    const updateDomFromExternal = debounce(() => {
      this.domAndFingerprintLock.use(async () => {
        const [dom, fingerprint] = await this.loadDomAndFingerprint();
        const newFingerprint = await calculateDomFingerprint(this.root);
        if (fingerprint !== newFingerprint) {
          // eslint-disable-next-line no-console
          console.log(`${chalk.magenta('event')} - Project changed on disk, updating...`);
          this.domAndFingerprint = await Promise.all([
            loadDomFromDisk(),
            calculateDomFingerprint(this.root),
          ]);
          this.events.emit('change', { fingerprint });
          this.events.emit('externalChange', { fingerprint });

          const newCodeComponentsFingerprint = getCodeComponentsFingerprint(dom);
          if (this.codeComponentsFingerprint !== newCodeComponentsFingerprint) {
            this.codeComponentsFingerprint = newCodeComponentsFingerprint;
            if (this.codeComponentsFingerprint !== null) {
              this.events.emit('componentsListChanged', {});
            }
          }
        }
      });
    }, 100);

    chokidar.watch(getDomFilePatterns(this.root)).on('all', () => {
      updateDomFromExternal();
    });
  }

  private async loadDomAndFingerprint() {
    if (!this.domAndFingerprint) {
      this.domAndFingerprint = Promise.all([loadDomFromDisk(), calculateDomFingerprint(this.root)]);
    }
    return this.domAndFingerprint;
  }

  getRoot() {
    return this.root;
  }

  getToolpadFolder() {
    return getToolpadFolder(this.getRoot());
  }

  getOutputFolder() {
    return getOutputFolder(this.getRoot());
  }

  async loadDom() {
    const [dom] = await this.loadDomAndFingerprint();
    return dom;
  }

  async writeDomToDisk(newDom: appDom.AppDom) {
    if (config.cmd !== 'dev') {
      throw new Error(`Writing to disk is only possible in toolpad dev mode.`);
    }

    await writeDomToDisk(newDom);
    const newFingerprint = await calculateDomFingerprint(this.root);
    this.domAndFingerprint = [newDom, newFingerprint];
    this.events.emit('change', { fingerprint: newFingerprint });
    return { fingerprint: newFingerprint };
  }

  async saveDom(newDom: appDom.AppDom) {
    return this.domAndFingerprintLock.use(async () => {
      return this.writeDomToDisk(newDom);
    });
  }

  async applyDomDiff(domDiff: appDom.DomDiff) {
    return this.domAndFingerprintLock.use(async () => {
      const dom = await this.loadDom();
      const newDom = appDom.applyDiff(dom, domDiff);
      return this.writeDomToDisk(newDom);
    });
  }

  async openCodeEditor(file: string): Promise<void> {
    const supportedEditor = await getSupportedEditor();
    if (!supportedEditor) {
      throw new Error(`No code editor found`);
    }
    const fullPath = path.resolve(this.getRoot(), file);
    openEditor([fullPath, this.getRoot()], {
      editor: process.env.EDITOR ? undefined : DEFAULT_EDITOR,
    });
  }
}

export async function initProject() {
  const root = getUserProjectRoot();

  await migrateLegacyProject(root);

  await initToolpadFolder(root);

  return new ToolpadProject(root, { dev: config.cmd === 'dev' });
}
