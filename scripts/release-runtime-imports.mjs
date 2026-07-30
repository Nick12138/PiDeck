const NODE_RUNTIME_ENTRYPOINTS = Object.freeze({
  "pdfjs-dist": "pdfjs-dist/legacy/build/pdf.mjs",
});

export function releaseRuntimeImportSpecifiers(productionDependencies) {
  return Object.keys(productionDependencies).map(
    (packageName) => NODE_RUNTIME_ENTRYPOINTS[packageName] ?? packageName,
  );
}
