/**
 * API Spec Generator — Parse HTML docs into JSON spec
 *
 * Reads FortiManager HTML API reference docs and produces a structured
 * JSON spec file for use by the search executor.
 *
 * Usage: npx tsx scripts/generate-spec.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type {
  FmgApiSpec,
  FmgAttributeDef,
  FmgErrorCode,
  FmgMethodDef,
  FmgModule,
  FmgObjectDef,
  FmgObjectUrl,
  FmgOptionValue,
  FmgParamDef,
} from '../src/types/spec-types.js';

// ─── Configuration ──────────────────────────────────────────────────

interface SpecConfig {
  version: string;
  htmlDirPattern: RegExp;
  outputPath: string;
}

const SPECS: SpecConfig[] = [
  {
    version: '7.4',
    htmlDirPattern: /^FortiManager-(7\.4\.\d+)-JSON-API-Reference$/,
    outputPath: 'src/spec/fmg-api-spec-7.4.json',
  },
  {
    version: '7.6',
    htmlDirPattern: /^FortiManager-(7\.6\.\d+)-JSON-API-Reference$/,
    outputPath: 'src/spec/fmg-api-spec-7.6.json',
  },
];

// ─── Main ───────────────────────────────────────────────────────────

function main(): void {
  const rootDir = process.cwd();
  const apiReferenceDir = path.resolve(rootDir, 'docs/api-reference');

  for (const specConfig of SPECS) {
    const htmlDir = findLatestHtmlDir(
      apiReferenceDir,
      specConfig.version,
      specConfig.htmlDirPattern,
    );
    const outputPath = path.resolve(rootDir, specConfig.outputPath);

    if (!htmlDir) {
      console.warn(
        `Skipping ${specConfig.version}: matching HTML docs not found in ${apiReferenceDir}`,
      );
      continue;
    }

    console.log(`\nGenerating spec for FMG ${specConfig.version}...`);
    console.log(`  Source: ${htmlDir}`);
    console.log(`  Output: ${outputPath}`);

    const spec = generateSpec(htmlDir, specConfig.version);

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2));

    // Print stats
    const totalObjects = spec.modules.reduce((sum, m) => sum + m.objects.length, 0);
    const totalMethods = spec.modules.reduce((sum, m) => sum + m.methods.length, 0);
    const totalErrors = spec.errors.length;
    const totalUrls = spec.modules.reduce(
      (sum, m) => sum + m.objects.reduce((s, o) => s + o.urls.length, 0),
      0,
    );
    const totalAttrs = spec.modules.reduce(
      (sum, m) => sum + m.objects.reduce((s, o) => s + o.attributes.length, 0),
      0,
    );

    console.log(`  Modules:    ${spec.modules.length}`);
    console.log(`  Objects:    ${totalObjects}`);
    console.log(`  URLs:       ${totalUrls}`);
    console.log(`  Attributes: ${totalAttrs}`);
    console.log(`  Methods:    ${totalMethods}`);
    console.log(`  Errors:     ${totalErrors}`);

    const fileSizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
    console.log(`  File size:  ${fileSizeMB} MB`);
  }
}

function findLatestHtmlDir(
  apiReferenceDir: string,
  version: string,
  htmlDirPattern: RegExp,
): string | null {
  if (!fs.existsSync(apiReferenceDir)) {
    return null;
  }

  const matchedDirectories = fs
    .readdirSync(apiReferenceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, match: entry.name.match(htmlDirPattern) }))
    .filter((entry): entry is { name: string; match: RegExpMatchArray } => entry.match !== null)
    .map(({ name, match }) => ({
      name,
      patchVersion: Number.parseInt(match[1]!.split('.')[2]!, 10),
    }))
    .filter(({ patchVersion }) => Number.isFinite(patchVersion))
    .sort((a, b) => b.patchVersion - a.patchVersion);

  const latestDirectory = matchedDirectories[0];
  if (!latestDirectory) {
    return null;
  }

  const htmlDir = path.join(apiReferenceDir, latestDirectory.name, 'html');
  if (!fs.existsSync(htmlDir)) {
    console.warn(
      `Skipping ${version}: resolved latest directory ${latestDirectory.name}, but html subdir is missing`,
    );
    return null;
  }

  return htmlDir;
}

// ─── Spec Generation ────────────────────────────────────────────────

function generateSpec(htmlDir: string, version: string): FmgApiSpec {
  const files = fs.readdirSync(htmlDir).filter((f) => f.endsWith('.htm'));

  // Group files by module prefix
  const moduleMap = discoverModules(files);

  // Extract build number from any objects file
  const build = extractBuildNumber(htmlDir, files);

  // Parse all modules
  const modules: FmgModule[] = [];
  const allErrors: FmgErrorCode[] = [];

  for (const [moduleName, moduleFiles] of moduleMap.entries()) {
    const mod = parseModule(htmlDir, moduleName, moduleFiles);
    if (mod) {
      modules.push(mod);
    }

    // Collect errors
    const errorsFile = moduleFiles.find((f) => f.endsWith('-errors.htm'));
    if (errorsFile) {
      const errors = parseErrorsFile(htmlDir, errorsFile);
      // Only add unique error codes
      for (const err of errors) {
        if (!allErrors.some((e) => e.code === err.code)) {
          allErrors.push(err);
        }
      }
    }
  }

  // Sort errors by code
  allErrors.sort((a, b) => a.code - b.code);

  return {
    version,
    build,
    generatedAt: new Date().toISOString(),
    modules,
    errors: allErrors,
  };
}

// ─── Module Discovery ───────────────────────────────────────────────

/**
 * Group HTML files by module prefix.
 * e.g., "sys-methods.htm", "sys-objects.htm" → module "sys"
 * e.g., "pkg76-3645-main.htm", "pkg76-3645-objects.htm" → module "pkg76-3645"
 */
function discoverModules(files: string[]): Map<string, string[]> {
  const moduleMap = new Map<string, string[]>();

  for (const file of files) {
    // Skip non-module files
    if (
      file === 'index.htm' ||
      file === 'objects.htm' ||
      file === 'obj-index.htm' ||
      file === 'faz-cmd-index.htm'
    ) {
      continue;
    }

    // Extract module prefix: everything before the last "-type.htm"
    const match = file.match(/^(.+?)-(main|methods|objects|errors|examples|aux)\.htm$/);
    if (!match) {
      // FAZ files like "faz_eventmgmt.htm" or "soarconfig.htm"
      // These are standalone files, treat as their own module
      const baseName = file.replace('.htm', '');
      if (!moduleMap.has(baseName)) {
        moduleMap.set(baseName, []);
      }
      moduleMap.get(baseName)!.push(file);
      continue;
    }

    const prefix = match[1]!;
    if (!moduleMap.has(prefix)) {
      moduleMap.set(prefix, []);
    }
    moduleMap.get(prefix)!.push(file);
  }

  return moduleMap;
}

// ─── Module Parsing ─────────────────────────────────────────────────

function parseModule(htmlDir: string, moduleName: string, moduleFiles: string[]): FmgModule | null {
  const methodsFile = moduleFiles.find((f) => f.endsWith('-methods.htm'));
  const objectsFile = moduleFiles.find((f) => f.endsWith('-objects.htm'));

  // Skip modules with neither methods nor objects
  if (!methodsFile && !objectsFile) {
    // Standalone files (FAZ, etc.) — parse as objects-only
    const standaloneFile = moduleFiles.find((f) => !f.includes('-'));
    if (standaloneFile) {
      return parseStandaloneModule(htmlDir, moduleName, standaloneFile);
    }
    return null;
  }

  let title = moduleName;
  const methods: FmgMethodDef[] = [];
  const objects: FmgObjectDef[] = [];

  // Parse methods
  if (methodsFile) {
    const html = readFile(htmlDir, methodsFile);
    const $ = cheerio.load(html);
    title = $('div.content h1').first().text().trim() || moduleName;
    methods.push(...parseMethodsHtml($));
  }

  // Parse objects
  if (objectsFile) {
    const html = readFile(htmlDir, objectsFile);
    const $ = cheerio.load(html);
    if (!title || title === moduleName) {
      title = $('div.content h1').first().text().trim() || moduleName;
    }
    objects.push(...parseObjectsHtml($));
  }

  return { name: moduleName, title, methods, objects };
}

/** Parse standalone FAZ/SOAR files that don't follow the *-type.htm pattern */
function parseStandaloneModule(
  htmlDir: string,
  moduleName: string,
  fileName: string,
): FmgModule | null {
  const html = readFile(htmlDir, fileName);
  const $ = cheerio.load(html);

  const title = $('div.content h1').first().text().trim() || moduleName;
  const objects = parseObjectsHtml($);

  if (objects.length === 0) {
    return null;
  }

  return { name: moduleName, title, methods: [], objects };
}

// ─── Methods Parsing ────────────────────────────────────────────────

function parseMethodsHtml($: cheerio.CheerioAPI): FmgMethodDef[] {
  const methods: FmgMethodDef[] = [];

  $('div.content > div[id]').each((_i, el) => {
    const $div = $(el);
    const id = $div.attr('id') ?? '';
    const name = $div.find('> h2').first().text().trim();
    const description = $div.find('> p').first().text().trim();

    // Extract JSON templates from <pre> blocks
    const preBlocks = $div.find('> pre');
    const requestTemplate = preBlocks.eq(0).text().trim() || undefined;
    const responseTemplate = preBlocks.eq(1).text().trim() || undefined;

    // Parse parameter table
    const params = parseParamTable($, $div.find('> table.param_table').first());

    methods.push({
      id,
      name,
      description,
      requestTemplate,
      responseTemplate,
      params,
    });
  });

  return methods;
}

// ─── Objects Parsing ────────────────────────────────────────────────

function parseObjectsHtml($: cheerio.CheerioAPI): FmgObjectDef[] {
  const objects: FmgObjectDef[] = [];

  $('div.content > div[id]').each((_i, el) => {
    const $div = $(el);
    const h2Text = $div.find('> h2').first().text().trim();

    // Parse name and type from h2: "firewall/address (table)"
    const typeMatch = h2Text.match(/^(.+?)\s*\((table|object|command)\)\s*$/i);
    const objName = typeMatch ? typeMatch[1]!.trim() : h2Text;
    const objType = (typeMatch ? typeMatch[2]!.toLowerCase() : 'object') as
      'table' | 'object' | 'command';

    // Description — first <p> that doesn't start with "Supported methods:"
    let description = '';
    $div.find('> p').each((_j, pEl) => {
      const text = $(pEl).text().trim();
      if (text && !text.startsWith('Supported methods:') && !description) {
        description = text;
      }
    });

    // Supported methods
    const methodIds: string[] = [];
    $div.find('> p').each((_j, pEl) => {
      const text = $(pEl).text().trim();
      if (text.startsWith('Supported methods:')) {
        $(pEl)
          .find('a')
          .each((_k, aEl) => {
            const href = $(aEl).attr('href') ?? '';
            const anchor = href.split('#')[1];
            if (anchor) {
              methodIds.push(anchor);
            }
          });
      }
    });

    // URL table (table without .param_table class)
    const urls = parseUrlTable($, $div);

    // Attribute tables (table.param_table)
    const paramTables = $div.find('> table.param_table');
    let attributes: FmgAttributeDef[] = [];
    let responseData: FmgAttributeDef[] | undefined;

    paramTables.each((_j, tableEl) => {
      const $table = $(tableEl);
      const headerText = $table.find('thead th').first().text().trim();

      if (headerText === 'Response Data') {
        responseData = parseParamTable($, $table);
      } else {
        // "Attribute List" or first table
        attributes = parseParamTable($, $table);
      }
    });

    objects.push({
      name: objName,
      type: objType,
      description,
      methods: methodIds,
      urls,
      attributes,
      ...(responseData && responseData.length > 0 ? { responseData } : {}),
    });
  });

  return objects;
}

// ─── URL Table Parsing ──────────────────────────────────────────────

function parseUrlTable($: cheerio.CheerioAPI, $div: cheerio.Cheerio<Element>): FmgObjectUrl[] {
  const urls: FmgObjectUrl[] = [];

  // URL table is the <table> without .param_table class
  $div.find('> table:not(.param_table)').each((_i, tableEl) => {
    $(tableEl)
      .find('tr')
      .each((_j, trEl) => {
        const category = $(trEl).find('td.table_col_name').text().trim();
        const $descTd = $(trEl).find('td.table_col_desc');
        const descHtml = $descTd.html() ?? '';

        if (category && descHtml) {
          // URLs are separated by <br> or <br/> tags in the HTML.
          // Using .text() would concatenate them without separators,
          // so we split on <br> tags and decode HTML entities.
          const paths = descHtml
            .split(/<br\s*\/?>/i)
            .map((fragment) => {
              // Strip any remaining HTML tags and decode entities
              const text = cheerio.load(`<span>${fragment}</span>`)('span').text().trim();
              return text;
            })
            .filter(Boolean);
          for (const p of paths) {
            urls.push({ category, path: p });
          }
        }
      });
  });

  return urls;
}

// ─── Parameter/Attribute Table Parsing ──────────────────────────────

function parseParamTable($: cheerio.CheerioAPI, $table: cheerio.Cheerio<Element>): FmgParamDef[] {
  const params: FmgParamDef[] = [];

  $table.find('> tbody > tr, > tr').each((_i, trEl) => {
    const $tr = $(trEl);
    const $nameTd = $tr.find('> td.table_col_name').first();
    const $descTd = $tr.find('> td.table_col_desc').first();

    if ($nameTd.length === 0 || $descTd.length === 0) return;

    const name = $nameTd.text().trim();
    if (!name) return;

    const attr = parseAttributeDesc($, $descTd, name);
    params.push(attr);
  });

  return params;
}

// ─── Attribute Description Parsing ──────────────────────────────────

function parseAttributeDesc(
  $: cheerio.CheerioAPI,
  $td: cheerio.Cheerio<Element>,
  name: string,
): FmgAttributeDef {
  const html = $td.html() ?? '';
  const fullText = $td.text().trim();

  // Read-only check
  const readOnly = fullText.startsWith('[read-only]') || html.includes('[read-only]');

  // Type extraction — first <i> element
  const type = $td.find('> i, i').first().text().trim() || 'unknown';

  // Size extraction (e.g. "(128 bytes)" or just "(128)")
  const sizeMatch = html.match(/\((\d+)\s*(?:bytes?)?\)/);
  const size = sizeMatch ? parseInt(sizeMatch[1]!, 10) : undefined;

  // Master key
  const masterKey = html.includes('<b>master key</b>') || html.includes('master key');

  // Default value
  const defaultMatch = html.match(/Default value:\s*(.+?)(?:<|$)/);
  const defaultValue = defaultMatch ? defaultMatch[1]!.trim() : undefined;

  // Description — text between type and options table, simplified
  let description: string | undefined;
  const descClean = fullText
    .replace(/^\[read-only\]\s*/, '')
    .replace(new RegExp(`^${escapeRegex(type)}\\s*`), '')
    .replace(/\(\d+\s*(?:bytes?)?\)\s*/, '')
    .replace(/master key\s*/, '')
    .replace(/Default value:.*$/, '')
    .trim();
  if (descClean && descClean !== name) {
    description = descClean;
  }

  // Options for "option" or "flags" types
  const options: FmgOptionValue[] = [];
  $td.find('> table tr, table tr').each((_i, trEl) => {
    const optName = $(trEl).find('td.table_col_name').text().trim().replace(/^"|"$/g, '');
    const optDesc = $(trEl).find('td.table_col_desc').text().trim();
    if (optName) {
      options.push({
        value: optName,
        ...(optDesc && !optDesc.includes('[Default value]') ? { description: optDesc } : {}),
        ...(optDesc.includes('[Default value]') ? { isDefault: true } : {}),
      });
    }
  });

  // Datasource reference
  let datasourceRef: string | undefined;
  if (type === 'datasource') {
    const refLink = $td.find('a').first();
    if (refLink.length) {
      datasourceRef = refLink.text().trim();
    }
  }

  // Child attributes for inline table types
  let children: FmgAttributeDef[] | undefined;
  if (type === 'table') {
    const childRows: FmgAttributeDef[] = [];
    $td.find('> table > tbody > tr, > table > tr').each((_i, trEl) => {
      const $childName = $(trEl).find('> td.table_col_name').first();
      const $childDesc = $(trEl).find('> td.table_col_desc').first();
      if ($childName.length && $childDesc.length) {
        const childName = $childName.text().trim();
        if (childName) {
          childRows.push(parseAttributeDesc($, $childDesc, childName));
        }
      }
    });
    if (childRows.length > 0) {
      children = childRows;
    }
  }

  return {
    name,
    type,
    ...(size !== undefined ? { size } : {}),
    ...(readOnly ? { readOnly } : {}),
    ...(masterKey ? { masterKey } : {}),
    ...(description ? { description } : {}),
    ...(defaultValue ? { defaultValue } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(datasourceRef ? { datasourceRef } : {}),
    ...(children ? { children } : {}),
  };
}

// ─── Errors Parsing ─────────────────────────────────────────────────

function parseErrorsFile(htmlDir: string, fileName: string): FmgErrorCode[] {
  const html = readFile(htmlDir, fileName);
  const $ = cheerio.load(html);
  const errors: FmgErrorCode[] = [];

  $('div.content table tr').each((_i, trEl) => {
    const codeText = $(trEl).find('td.macro_num').text().trim();
    const message = $(trEl).find('td.macro_val').text().trim();

    if (codeText && message) {
      const code = parseInt(codeText, 10);
      if (!isNaN(code)) {
        errors.push({ code, message });
      }
    }
  });

  return errors;
}

// ─── Utilities ──────────────────────────────────────────────────────

function readFile(dir: string, fileName: string): string {
  return fs.readFileSync(path.join(dir, fileName), 'utf-8');
}

function extractBuildNumber(htmlDir: string, files: string[]): string {
  // Try to extract from HTML title, e.g., "FortiManager 7.6.5 (3653) JSON API Reference"
  const indexFile = files.find((f) => f === 'index.htm');
  if (indexFile) {
    const html = readFile(htmlDir, indexFile);
    const $ = cheerio.load(html);
    const title = $('title').text();
    const buildMatch = title.match(/\((\d+)\)/);
    if (buildMatch) {
      return buildMatch[1]!;
    }
  }
  return 'unknown';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Run ────────────────────────────────────────────────────────────

try {
  main();
} catch (err: unknown) {
  console.error('Spec generation failed:', err);
  process.exit(1);
}
