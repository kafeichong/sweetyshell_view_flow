const ts = require('typescript');
const { pathToFileURL } = require('node:url');

// Jest 29 runs the existing suites as CommonJS. Preserve real Nest behavior while
// adapting ESM dependencies, including createRequire(import.meta.url), for Jest.
module.exports = {
  process(sourceText, sourcePath) {
    const result = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
        esModuleInterop: true,
        sourceMap: true,
        inlineSources: true,
      },
      transformers: {
        before: [context => {
          const visit = node => {
            if (ts.isPropertyAccessExpression(node)
              && ts.isMetaProperty(node.expression)
              && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
              && node.name.text === 'url') {
              return ts.factory.createStringLiteral(pathToFileURL(sourcePath).href);
            }
            return ts.visitEachChild(node, visit, context);
          };
          return sourceFile => ts.visitNode(sourceFile, visit);
        }],
      },
    });
    return { code: result.outputText, map: result.sourceMapText };
  },
};
