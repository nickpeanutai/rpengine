import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const modelDirectory = process.env.MOONSHINE_V2_MODEL_DIR;
if (!modelDirectory) throw new Error('Set MOONSHINE_V2_MODEL_DIR to a directory containing the seven small-streaming-en files.');

const platformLibrary = {
  'darwin-arm64': 'core/third-party/onnxruntime/lib/macos/arm64/libonnxruntime.1.23.2.dylib',
  'darwin-x64': 'core/third-party/onnxruntime/lib/macos/x86_64/libonnxruntime.1.23.2.dylib',
  'linux-arm64': 'core/third-party/onnxruntime/lib/linux/aarch64/libonnxruntime.so.1',
  'linux-x64': 'core/third-party/onnxruntime/lib/linux/x86_64/libonnxruntime.so.1',
}[`${process.platform}-${process.arch}`];
if (!platformLibrary) throw new Error(`Moonshine v2 native parity is unsupported on ${process.platform}-${process.arch}.`);

const nativeRoot = join(root, 'moonshine');
const ortLibrary = join(nativeRoot, platformLibrary);
const header = await readFile(ortLibrary);
if (header.subarray(0, 43).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
  throw new Error(`The native ONNX Runtime library is still a Git LFS pointer. Run: git -C moonshine lfs install --local && git -C moonshine lfs pull --include=${platformLibrary}`);
}

const temporary = await mkdtemp(join(tmpdir(), 'rpengine-moonshine-v2-parity-'));
try {
  const executable = join(temporary, 'native-parity');
  const include = path => ['-I', join(nativeRoot, path)];
  const sources = [
    'core/moonshine-streaming-model.cpp',
    'core/bin-tokenizer/bin-tokenizer.cpp',
    'core/ort-utils/ort-utils.cpp',
    'core/ort-utils/ort-utils-ep.cpp',
    'core/ort-utils/moonshine-ort-allocator.cpp',
    'core/moonshine-utils/debug-utils.cpp',
    'core/moonshine-utils/string-utils.cpp',
    'core/moonshine-utils/file-utils.cpp',
  ].map(path => join(nativeRoot, path));
  run('c++', [
    '-std=c++20', '-O2',
    ...include('core'), ...include('core/moonshine-utils'), ...include('core/ort-utils'), ...include('core/bin-tokenizer'), ...include('core/third-party/onnxruntime/include'),
    join(root, 'scripts/moonshine-v2-native-parity.cpp'), ...sources, ortLibrary,
    `-Wl,-rpath,${dirname(ortLibrary)}`, '-o', executable,
  ]);
  const fixture = join(nativeRoot, 'test-assets/two_cities_16k.wav');
  const native = run(executable, [modelDirectory, fixture], true);
  JSON.parse(native);
  const nativeResult = join(temporary, 'native-result.json');
  await writeFile(nativeResult, native);
  run('npx', ['vitest', 'run', 'src/moonshine-v2-native-parity.test.ts', '--reporter=verbose'], false, {
    ...process.env,
    MOONSHINE_V2_MODEL_DIR: modelDirectory,
    MOONSHINE_V2_NATIVE_RESULT: nativeResult,
  });
  console.log('Moonshine v2 native C++ / ORT-Web token and transcript parity passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, capture = false, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(capture ? result.stderr.trim() || `${command} exited ${result.status}` : `${command} exited ${result.status}`);
  return result.stdout ?? '';
}
