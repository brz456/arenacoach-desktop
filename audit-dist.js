#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');
const asar = require('@electron/asar');

const FORBIDDEN_PATH_PATTERNS = [
  /[/\\]test[/\\]/i,   // **/test/**
  /\.map$/i,           // *.map (js.map, d.ts.map)
  /\.d\.ts$/i,         // *.d.ts
];

const FORBIDDEN_CONTENT_PATTERNS = [
  /\bTODO\b/,
  /\bFIXME\b/,
];

const SCANNABLE_EXTENSIONS = new Set(['.js', '.json', '.html', '.css']);

function findAsarIssues(asarPath) {
  const issues = [];
  const filePaths = asar.listPackage(asarPath);

  for (const rawPath of filePaths) {
    // Normalize path (remove leading slash if present)
    const filePath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;

    // Only audit dist/ directory, skip node_modules and other paths
    if (!filePath.startsWith('dist/')) {
      continue;
    }

    // Check path against forbidden patterns
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(filePath)) {
        issues.push({
          type: 'path',
          reason: `Forbidden path pattern: ${pattern}`,
          file: filePath,
        });
      }
    }

    // Content-based checks for scannable files
    const ext = path.extname(filePath).toLowerCase();
    if (SCANNABLE_EXTENSIONS.has(ext)) {
      try {
        const content = asar.extractFile(asarPath, filePath).toString('utf-8');
        for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
          if (pattern.test(content)) {
            issues.push({
              type: 'content',
              reason: `Forbidden content pattern: ${pattern}`,
              file: filePath,
            });
          }
        }
      } catch (err) {
        issues.push({
          type: 'error',
          reason: `Failed to read file: ${err.message}`,
          file: filePath,
        });
      }
    }
  }

  return issues;
}

async function findUnpackedIssues(unpackedRoot) {
  const issues = [];

  // Check if unpacked root exists - it's optional (not all builds have unpacked files)
  try {
    await fs.stat(unpackedRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return issues; // No unpacked directory is valid
    }
    throw err;
  }

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      issues.push({
        type: 'error',
        reason: `Failed to read directory: ${err.message}`,
        file: path.relative(unpackedRoot, dir),
      });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(unpackedRoot, fullPath);

      if (entry.isDirectory()) {
        // Check directory path against forbidden patterns
        for (const pattern of FORBIDDEN_PATH_PATTERNS) {
          if (pattern.test(relativePath + path.sep)) {
            issues.push({
              type: 'path',
              reason: `Forbidden path pattern: ${pattern}`,
              file: `[unpacked] ${relativePath}`,
            });
          }
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        // Check file path against forbidden patterns
        for (const pattern of FORBIDDEN_PATH_PATTERNS) {
          if (pattern.test(relativePath)) {
            issues.push({
              type: 'path',
              reason: `Forbidden path pattern: ${pattern}`,
              file: `[unpacked] ${relativePath}`,
            });
          }
        }

        // Content-based checks for scannable files
        const ext = path.extname(entry.name).toLowerCase();
        if (SCANNABLE_EXTENSIONS.has(ext)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
            if (pattern.test(content)) {
              issues.push({
                type: 'content',
                reason: `Forbidden content pattern: ${pattern}`,
                file: `[unpacked] ${relativePath}`,
              });
            }
          }
        }
      }
    }
  }

  await walk(unpackedRoot);
  return issues;
}

function printAndExit(issues) {
  if (issues.length === 0) {
    console.log('audit: No issues found in packaged app.');
    process.exit(0);
  }

  console.error(`audit: ${issues.length} issue(s) found:\n`);
  for (const issue of issues) {
    console.error(`  [${issue.type}] ${issue.file}`);
    console.error(`    ${issue.reason}\n`);
  }
  process.exit(1);
}

async function main() {
  const resourcesRoot = path.join(__dirname, 'release', 'linux-unpacked', 'resources');
  const asarPath = path.join(resourcesRoot, 'app.asar');
  const unpackedPath = path.join(resourcesRoot, 'app.asar.unpacked');

  try {
    await fs.stat(asarPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`audit: Packaged app not found: ${asarPath}`);
      console.error('Run "npm run dist" first.');
      process.exit(1);
    }
    throw err;
  }

  const asarIssues = findAsarIssues(asarPath);
  const unpackedIssues = await findUnpackedIssues(unpackedPath);
  const allIssues = [...asarIssues, ...unpackedIssues];

  printAndExit(allIssues);
}

main().catch((err) => {
  console.error('audit: Unexpected error:', err);
  process.exit(1);
});
