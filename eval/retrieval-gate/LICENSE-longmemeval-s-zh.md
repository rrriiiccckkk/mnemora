# longmemeval-s-zh.json.gz

A reduced subset of LongMemEval_S (the retrieval gate's 100 questions, each
with its evidence sessions and 8 other sessions of its haystack; assistant
turns that are not evidence cut to 800 characters), machine-translated to
Simplified Chinese with `mimo-v2.6-pro` at temperature 0. Question and
session ids, dates and evidence labels are unchanged. Built by
`scripts/build-zh-gate-dataset.mjs`; used by `scripts/retrieval-gate.mjs`
with `baseline-zh.json` and `baseline-zh-4000.json`. Translation can change
wording and lose detail; it measures recall regressions, not translation.

Source: LongMemEval, https://github.com/xiaowu0162/LongMemEval (cleaned
release: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).

MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
