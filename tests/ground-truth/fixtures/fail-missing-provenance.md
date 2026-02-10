---
title: Test Fixture — Missing Provenance Tags
---

# Test Document

## Overview

This paragraph has no provenance tag at all. It should be flagged.

Another untagged paragraph that should fail the coverage check.

Yet another paragraph without a tag.

A fourth paragraph missing its tag.

And a fifth — this pushes coverage well below 95%.

<!-- provenance: CODE-FACTUAL -->
<!-- evidence: symbol=WALManager -->
Only this paragraph has a proper tag, citing `src/persistence/index.ts:1`.
