// Bundles the sidebar webview (webview/sidebar, React) into media/sidebar.js, one file the webview's CSP allows
// with its nonce. `--watch` rebuilds on change. Types are checked separately (tsconfig.webview.json).
import * as esbuild from 'esbuild';

const options = {
  entryPoints: ['webview/sidebar/main.tsx'],
  bundle: true,
  outfile: 'media/sidebar.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching webview/sidebar');
} else {
  await esbuild.build(options);
}
