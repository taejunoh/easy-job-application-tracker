import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import golden from "./next-root-glob.golden.json";

const root = resolve(__dirname, "../..");
const localRequire = createRequire(join(root, "package.json"));
const sourcePath = join(root, "tools/next-root-glob/index.cjs");
const adapterPath = join(root, "node_modules/@jobtracker/next-root-glob/index.cjs");
const adapter = () => localRequire(adapterPath) as {
  globSync: (pattern: unknown, options: unknown) => string[];
};
let fixture: string;
let previousCwd: string;

beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "next-root-compat-")));
  for (const dir of ["packages/a/web", "packages/b/web", "packages/.hidden/web", "@scope/app/web", "with space/web", ".hidden", "packages/a/web/.nested"]) {
    mkdirSync(join(fixture, dir), { recursive: true });
  }
  writeFileSync(join(fixture, "packages/plain-file"), "not a directory");
  symlinkSync("packages/a", join(fixture, "link"), "dir");
  previousCwd = process.cwd();
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(fixture, { recursive: true, force: true });
});

describe("restricted Next root-directory adapter", () => {
  it("provides its own private package rather than impersonating fast-glob", () => {
    expect(existsSync(adapterPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, "tools/next-root-glob/package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "@jobtracker/next-root-glob", private: true, version: "1.0.1", main: "index.cjs", dependencies: { tinyglobby: "0.2.17", picomatch: "4.0.4" } });
    expect(Object.keys(adapter())).toEqual(["globSync"]);
  });

  it.each(golden.cases)("preserves captured directory identities for $pattern", ({ pattern, paths, identities }) => {
    process.chdir(fixture);
    try {
      const input = pattern.startsWith("ABS:") ? join(fixture, pattern.slice(4)) : pattern;
      const result = adapter().globSync(input, { onlyDirectories: true });
      expect([...new Set(result.map(p => relative(fixture, resolve(p)) || "."))].sort()).toEqual(paths);
      expect([...new Set(result.map(p => relative(fixture, realpathSync(p)) || "."))].sort()).toEqual(identities);
      if (isAbsolute(input)) expect(result.every(isAbsolute)).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it.each(["src/**", "src/{**,lib}", "src/!(lib)/**", "src/{a,b}", "src/[ab]", "src/?", "src/a*", "a*", "src/*a", "src/***", "!src", "src/@(lib)", "src/+(lib)", "src/(lib)", ...(process.platform === "win32" ? [] : ["src/\\*"]), "src/\nlib", "src/\u0000lib", "src/\u0085lib", "x".repeat(4097), ""])("throws for unsupported pattern %j", pattern => {
    expect(() => adapter().globSync(pattern, { onlyDirectories: true })).toThrow(TypeError);
  });

  it.each([undefined, null, 1, ["packages/*/web"], {}, Symbol("pattern")])("rejects non-string patterns %p", pattern => {
    expect(() => adapter().globSync(pattern, { onlyDirectories: true })).toThrow(TypeError);
  });

  it.each([undefined, null, true, [], {}, { onlyDirectories: false }, { onlyDirectories: true, dot: true }, { onlyDirectories: true, [Symbol("option")]: true }, Object.create({ onlyDirectories: true })])("rejects malformed or broader options %p", options => {
    expect(() => adapter().globSync(".", options)).toThrow(TypeError);
  });

  it("rejects inherited options and accessor properties without invoking them", () => {
    const inherited = Object.assign(Object.create({ dot: true }), { onlyDirectories: true });
    expect(() => adapter().globSync(".", inherited)).toThrow(TypeError);
    const accessor = { get onlyDirectories() { throw new Error("getter must not run"); } };
    expect(() => adapter().globSync(".", accessor)).toThrow(TypeError);
  });

  it("does not turn a literal file into a directory match", () => {
    expect(adapter().globSync(join(fixture, "packages/plain-file"), { onlyDirectories: true })).toEqual([]);
  });

  it.each(["packages/*/../web", "packages/*/./web", "*/..", "*/."])("rejects normalization across a wildcard in %j", pattern => {
    expect(() => adapter().globSync(pattern, { onlyDirectories: true })).toThrow(TypeError);
  });

  it("keeps leading relative paths and literal dot segments", () => {
    process.chdir(fixture);
    try {
      for (const pattern of ["./packages/a/../b/web", `../${relative(resolve(fixture, ".."), fixture)}/packages/b/web`]) {
        expect(adapter().globSync(pattern, { onlyDirectories: true }).map(p => realpathSync(p))).toEqual([join(fixture, "packages/b/web")]);
      }
    } finally { process.chdir(previousCwd); }
  });

  it("preserves nested, broken, file, self-cycle and parent aliases in a bounded child", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
      const {globSync}=require(process.argv[1]);
      const golden=JSON.parse(process.argv[2]);
      const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'next-alias-compat-')));
      for(const dir of ['packages/a/web','packages/b/web','packages/.hidden/web','@scope/app/web','with space/web','.hidden','packages/a/web/.nested']) fs.mkdirSync(path.join(root,dir),{recursive:true});
      fs.writeFileSync(path.join(root,'packages/plain-file'),'not a directory');
      for(const [name,target] of [['link','packages/a'],['nested-alias','link'],['broken','missing'],['file-link','packages/plain-file'],['cycle','.'],['packages/a/parent','..'],['not-directory','packages/plain-file/child'],['unresolvable-cycle','unresolvable-cycle']]) fs.symlinkSync(target,path.join(root,name));
      const old=process.cwd();process.chdir(root);
      try {
        console.log(JSON.stringify(golden.map(({pattern})=>{
          const output=globSync(pattern,{onlyDirectories:true});
          return {pattern,paths:[...new Set(output.map(p=>path.relative(root,path.resolve(p))||'.'))].sort(),identities:[...new Set(output.map(p=>path.relative(root,fs.realpathSync(p))||'.'))].sort()};
        })));
      } finally {process.chdir(old);fs.rmSync(root,{recursive:true,force:true});}
    `, adapterPath, JSON.stringify(golden.aliasCases)], { encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual(golden.aliasCases);
  });

  it("propagates an unexpected symlink stat error without losing its identity", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const fs=require('node:fs'), path=require('node:path');
      const {globSync}=require(process.argv[1]);
      const directory=process.argv[2], target=path.join(directory,'link');
      const original=fs.statSync;
      const failure=Object.assign(new Error('injected filesystem failure'),{code:'EACCES'});
      fs.statSync=(file,...rest)=>{if(file===target)throw failure;return original(file,...rest);};
      process.chdir(directory);
      try {globSync('*',{onlyDirectories:true});process.exitCode=2;}
      catch(error){if(error!==failure)throw new Error('original error lost');}
      finally {fs.statSync=original;}
    `, adapterPath, fixture], { encoding: "utf8", timeout: 3000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
  });

  it("propagates a directory-read failure with its identity and clears per-call error state", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const fs=require('node:fs'), path=require('node:path');
      const {globSync}=require(process.argv[1]);
      const directory=process.argv[2], original=fs.readdirSync;
      const failure=Object.assign(new Error('injected directory-read failure'),{code:'EACCES'});
      fs.readdirSync=(file,...rest)=>{if(path.resolve(file)===directory)throw failure;return original(file,...rest);};
      process.chdir(directory);
      try {globSync('*',{onlyDirectories:true});process.exitCode=2;}
      catch(error){if(error!==failure)throw new Error('original error lost');}
      finally {fs.readdirSync=original;}
      if(globSync('*',{onlyDirectories:true}).length===0)throw new Error('per-call state leaked');
    `, adapterPath, fixture], { encoding: "utf8", timeout: 3000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
  });

  it("rejects POSIX backslash escapes, or normalizes native Windows separators", () => {
    process.chdir(fixture);
    try {
      if (process.platform === "win32") {
        expect(adapter().globSync("packages\\*\\web", { onlyDirectories: true }).length).toBe(2);
      } else {
        expect(() => adapter().globSync("packages\\*\\web", { onlyDirectories: true })).toThrow(TypeError);
      }
    } finally { process.chdir(previousCwd); }
  });

  it("rejects hostile nested braces in a bounded child without parsing or overflowing", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const {globSync}=require(process.argv[1]);
      for (const n of [1000, 10000, 100000]) {
        try { globSync('src/'+'{'.repeat(n)+'a'+'}'.repeat(n),{onlyDirectories:true}); process.exit(2); }
        catch(error) { if (!(error instanceof TypeError)) throw error; }
      }
    `, adapterPath], { timeout: 3000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
  });
});

describe("committed private package artifact", () => {
  it("reproduces the committed tarball byte-for-byte with the exact allowlisted files", () => {
    const child = spawnSync("npm", ["pack", "./tools/next-root-glob", "--pack-destination", fixture, "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8", timeout: 15000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const [pack] = JSON.parse(child.stdout) as { filename: string; files: { path: string }[] }[];
    expect(pack.files.map(file => file.path).sort()).toEqual(["README.md", "index.cjs", "package.json"]);
    const generated = join(fixture, pack.filename);
    const committed = join(root, "tools/vendor/jobtracker-next-root-glob-1.0.1.tgz");
    expect(readFileSync(generated)).toEqual(readFileSync(committed));
    const archive = spawnSync("tar", ["-tzf", committed], { encoding: "utf8", timeout: 3000 });
    expect(archive.status).toBe(0);
    expect(archive.stdout.trim().split("\n").sort()).toEqual(["package/README.md", "package/index.cjs", "package/package.json"]);
  });

  it("installs source bytes and resolves the honest identity through the actual Next edge", () => {
    const nextRequire = createRequire(localRequire.resolve("@next/eslint-plugin-next"));
    const installed = nextRequire.resolve("fast-glob");
    const pkg = nextRequire("fast-glob/package.json");
    expect(pkg).toMatchObject({ name: "@jobtracker/next-root-glob", version: "1.0.1", private: true });
    expect(pkg.dependencies).toEqual({ tinyglobby: "0.2.17", picomatch: "4.0.4" });
    for (const file of ["index.cjs", "README.md", "package.json"]) {
      expect(readFileSync(join(dirname(installed), file))).toEqual(readFileSync(join(dirname(sourcePath), file)));
      expect(readFileSync(join(dirname(localRequire.resolve("@jobtracker/next-root-glob")), file))).toEqual(readFileSync(join(dirname(sourcePath), file)));
    }
  });
});

describe("real Next 16.3.6 consumer", () => {
  const pluginPackage = localRequire("@next/eslint-plugin-next/package.json") as { version: string };
  const pluginDist = dirname(localRequire.resolve("@next/eslint-plugin-next"));
  const consumerPath = join(pluginDist, "utils/get-root-dirs.js");
  const consumerSource = readFileSync(consumerPath, "utf8");
  const checkConsumerContract = (source = consumerSource, version = pluginPackage.version) => spawnSync(process.execPath, ["-e", `
    const vm=require('node:vm'), assert=require('node:assert/strict');
    const source=process.argv[1], version=process.argv[2];
    assert.equal(version,'16.3.6');
    const imports=[], members=[], calls=[];
    const dependency=new Proxy({}, {get(_,member){
      members.push(member);
      if(member!=='globSync')throw new Error('unsupported fast-glob API');
      return (...args)=>{
        assert.equal(args.length,2);
        assert.equal(typeof args[0],'string');
        assert.deepEqual(Reflect.ownKeys(args[1]),['onlyDirectories']);
        assert.equal(Object.getOwnPropertyDescriptor(args[1],'onlyDirectories').value,true);
        calls.push(args);return ['matched:'+args[0]];
      };
    }});
    const sandbox={exports:{},require(specifier){imports.push(specifier);if(specifier!=='fast-glob')throw new Error('unexpected import');return dependency;}};
    vm.runInNewContext(source,sandbox,{filename:'installed-next-get-root-dirs.js',timeout:1000});
    const {getRootDirs}=sandbox.exports;
    const defaultRoots=getRootDirs({cwd:'/default-only',settings:{}});
    assert.equal(calls.length,0);
    const literalRoots=getRootDirs({cwd:'/unused',settings:{next:{rootDir:'packages\\\\app\\\\web'}}});
    const arrayRoots=getRootDirs({cwd:'/unused',settings:{next:{rootDir:['packages\\\\a\\\\web',42,null,['ignored/nested'],'packages/*/web']}}});
    assert.deepEqual(imports,['fast-glob']);
    assert.deepEqual(members,['globSync','globSync','globSync']);
    assert.deepEqual(calls.map(args=>args[0]),['packages/app/web','packages/a/web','packages/*/web']);
    assert.deepEqual(JSON.parse(JSON.stringify(defaultRoots)),['/default-only']);
    assert.deepEqual(JSON.parse(JSON.stringify(literalRoots)),['matched:packages/app/web']);
    assert.deepEqual(JSON.parse(JSON.stringify(arrayRoots)),['matched:packages/a/web','matched:packages/*/web']);
    console.log(JSON.stringify({version,imports,members,calls,defaultRoots,literalRoots,arrayRoots}));
  `, source, version], { encoding: "utf8", timeout: 3000 });

  it("pins the installed consumer version, reviewed source and sole fast-glob import scope", () => {
    expect(pluginPackage.version).toBe("16.3.6");
    // Deliberate narrow maintenance sentinel: changed consumer source requires review.
    expect(createHash("sha256").update(consumerSource).digest("hex")).toBe("886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde");
    const importSites: string[] = [];
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (entry.name.endsWith(".js") && /["']fast-glob(?:\/[^"']*)?["']/u.test(readFileSync(file, "utf8"))) {
          importSites.push(relative(pluginDist, file).replace(/\\/g, "/"));
        }
      }
    };
    scan(pluginDist);
    expect(importSites.sort()).toEqual(["utils/get-root-dirs.js"]);
  });

  it("guards actual consumer string calls, exact own options, normalization and array fanout", () => {
    const child = checkConsumerContract();
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });

  it.each([
    ["broader options", "onlyDirectories: true", "onlyDirectories: true, dot: true"],
    ["another API", ".globSync", ".sync"],
    ["lost backslash normalization", "rootDir.replace(/\\\\/g, '/')", "rootDir"],
    ["lost array flattening", "}).flat();", "});"],
  ])("rejects isolated consumer mutation: %s", (_, search, replacement) => {
    const mutated = consumerSource.replace(search, replacement);
    expect(mutated).not.toBe(consumerSource);
    const child = checkConsumerContract(mutated);
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
  });

  it("rejects an isolated installed-version mutation", () => {
    const child = checkConsumerContract(consumerSource, "16.3.7");
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
  });

  const lintNext = (setting: unknown, cwd: string) => {
    const child = spawnSync(process.execPath, ["-e", `
      const {createRequire}=require('node:module');
      const req=createRequire(process.argv[1]);
      const {Linter}=req('eslint');
      const next=req('@next/eslint-plugin-next');
      const setting=JSON.parse(process.argv[2]);
      process.chdir(process.argv[3]);
      const {getRootDirs}=req('@next/eslint-plugin-next/dist/utils/get-root-dirs');
      const settings=setting===null?{}:{next:{rootDir:setting}};
      const roots=getRootDirs({cwd:process.cwd(),settings});
      const messages=new Linter().verify('export default function Page(){return <a href="/about">About</a>}', [{
        languageOptions:{ecmaVersion:2022,sourceType:'module',parserOptions:{ecmaFeatures:{jsx:true}}},
        plugins:{'@next/next':next},settings,rules:{'@next/next/no-html-link-for-pages':'error'}
      }]);
      console.log(JSON.stringify({roots,messages}));
    `, join(root, "package.json"), JSON.stringify(setting), cwd], { encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout) as { roots: string[]; messages: { ruleId: string }[] };
  };

  beforeAll(() => {
    for (const dir of ["pages", "packages/a/web/pages", "packages/b/web/pages", "with space/web/pages"]) {
      mkdirSync(join(fixture, dir), { recursive: true });
      writeFileSync(join(fixture, dir, "about.tsx"), "export default function About() { return null; }");
    }
  });

  it.each([null, ".", "with space/web", ["packages/a/web", "packages/b/web"], "packages/*/web"])("retains no-html-link-for-pages errors for rootDir %j", setting => {
    const result = lintNext(setting, fixture);
    expect(result.messages.map(m => m.ruleId)).toContain("@next/next/no-html-link-for-pages");
  });

  it("retains the real Next rule for a symlink root and wildcard-selected symlink", () => {
    for (const setting of ["link/web", "*/web"]) {
      const result = lintNext(setting, fixture);
      expect(result.roots.map(p => relative(fixture, resolve(fixture, p)))).toContain("link/web");
      expect(result.messages.map(m => m.ruleId)).toContain("@next/next/no-html-link-for-pages");
    }
  });

  it("default root uses context.cwd without invoking the adapter", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const {createRequire}=require('node:module');const req=createRequire(process.argv[1]);
      const pluginRequire=createRequire(req.resolve('@next/eslint-plugin-next'));
      pluginRequire('fast-glob').globSync=()=>{throw new Error('adapter called');};
      const {getRootDirs}=req('@next/eslint-plugin-next/dist/utils/get-root-dirs');
      console.log(JSON.stringify(getRootDirs({cwd:'/default-only',settings:{}})));
    `, join(root, "package.json")], { encoding: "utf8", timeout: 3000 });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(["/default-only"]);
  });

  it("preserves real React-hooks, JSX accessibility, TypeScript and Next lint rules", () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {createRequire} from 'node:module';
      const req=createRequire(process.argv[1]);const {ESLint}=req('eslint');
      const eslint=new ESLint({cwd:process.argv[2]});
      const [result]=await eslint.lintText('import {useState} from "react"; export default function Page({flag}: {flag:boolean}) { if(flag) useState(0); const unused: any = 1; return <><img src="/x.png"/><a href="/about">About</a></> }', {filePath:'src/dependency-rules-fixture.tsx'});
      console.log(JSON.stringify(result.messages.map(m=>m.ruleId)));
    `, join(root, "package.json"), root], { encoding: "utf8", timeout: 15000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(expect.arrayContaining(["react-hooks/rules-of-hooks", "jsx-a11y/alt-text", "@typescript-eslint/no-explicit-any", "@typescript-eslint/no-unused-vars", "@next/next/no-img-element"]));
  });
});
