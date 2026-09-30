#!/usr/bin/env node

/**
 * 500-Call Random Prompt Stress & Stability Test for op2gw
 *
 * Usage:
 *   node test-500.mjs
 *   node test-500.mjs --model muse-spark-1.3-contributor-free --total 500 --concurrency 5
 *   node test-500.mjs --total 50 --concurrency 2
 */

import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:8787/v1/chat/completions' },
    model: { type: 'string', default: 'muse-spark-1.3-contributor-free' },
    total: { type: 'string', default: '500' },
    concurrency: { type: 'string', default: '4' },
    maxTokens: { type: 'string', default: '50' },
    timeout: { type: 'string', default: '60000' },
  },
})

const GATEWAY_URL = args.url
const MODEL = args.model
const TOTAL_CALLS = parseInt(args.total, 10)
const CONCURRENCY = parseInt(args.concurrency, 10)
const MAX_TOKENS = parseInt(args.maxTokens, 10)
const TIMEOUT_MS = parseInt(args.timeout, 10)

// 随机提问问答库（包含中英双语、算法编程、科学常识、逻辑推理与趣味简答）
const PROMPT_BANK = [
  '用一句话解释什么是量子计算。',
  'Python 中 list 和 tuple 的主要区别是什么？',
  '西红柿炒鸡蛋是先炒蛋还是先炒西红柿？简答。',
  '计算：17 乘以 23 等于多少？只给结果。',
  '简单解释什么是 Docker 容器？',
  '地球到月球的平均距离是多少公里？',
  '写一段快速排序（QuickSort）的核心思路。',
  '为什么天空是蓝色的？简明说明。',
  'SQL 中 WHERE 和 HAVING 的区别是什么？',
  '请用 10 个字以内写一句关于编程的幽默名言。',
  'HTTP 状态码 403 和 401 有什么本质区别？',
  '唐诗《静夜思》的作者是谁？',
  'JavaScript 的事件循环（Event Loop）由哪两部分任务组成？',
  '光速在真空中的速度是多少米每秒？',
  'Git 撤销最近一次尚未 push 的 commit 命令是什么？',
  '简要说明 TCP 三次握手的过程。',
  '列举 3 种富含维生素 C 的水果。',
  '如果今天是周四，100天后是星期几？',
  '什么是死锁？形成死锁的四个必要条件是什么？',
  '用一句话总结什么是机器学习中的过拟合（Overfitting）。',
  'What is the difference between synchronous and asynchronous code?',
  'Explain recursion in programming in one sentence.',
  'What is the capital of Australia?',
  'How does HTTPS encrypt traffic? Briefly summarize.',
  'Write a short regex to validate an email address.',
  'What is the purpose of an index in a database?',
  'Name the three primary colors of light.',
  'What does CPU stand for?',
  'Explain what a hash table is in two sentences.',
  'What is the boiling point of water at standard sea level in Celsius?',
  '用 15 字以内写一句早安问候语。',
  '什么是二叉搜索树（BST）？',
  '在 Linux 中如何查看端口 8080 被哪个进程占用？',
  '解释什么是 RESTful API？',
  '猫咪为什么会发出咕噜咕噜的声音？',
  '简述面向对象编程的三大基本特性。',
  '用 Python 写一行代码翻转字符串 "hello"。',
  '世界上最高的山峰是哪一座？海拔多少米？',
  '简要说明进程和线程的区别。',
  '什么是敏捷开发（Agile）？'
]

function getRandomPrompt() {
  const index = Math.floor(Math.random() * PROMPT_BANK.length)
  return PROMPT_BANK[index]
}

function percentile(arr, p) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1)
  return sorted[idx]
}

async function runTest() {
  console.log('='.repeat(70))
  console.log(`🚀 开始模型稳定性测试 (500次调用随机提问)`)
  console.log(`🎯 目标网关:   ${GATEWAY_URL}`)
  console.log(`🤖 测试模型:   ${MODEL}`)
  console.log(`📊 总请求数:   ${TOTAL_CALLS} 次`)
  console.log(`⚡ 并发数:     ${CONCURRENCY}`)
  console.log(`📏 max_tokens: ${MAX_TOKENS}`)
  console.log('='.repeat(70))

  const latencies = []
  const errorMap = new Map()
  let completed = 0
  let succeeded = 0
  let failed = 0
  const startTime = Date.now()

  let currentJobId = 0

  async function worker(workerId) {
    while (true) {
      const jobId = ++currentJobId
      if (jobId > TOTAL_CALLS) break

      const prompt = getRandomPrompt()
      const t0 = Date.now()
      let status = 0
      let errorMsg = ''
      let isSuccess = false

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

      try {
        const res = await fetch(GATEWAY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: MAX_TOKENS,
          }),
          signal: controller.signal,
        })
        clearTimeout(timer)
        status = res.status
        const dt = Date.now() - t0

        if (res.ok) {
          const body = await res.json()
          const content = body?.choices?.[0]?.message?.content || ''
          isSuccess = true
          latencies.push(dt)
          succeeded++
        } else {
          const text = await res.text()
          errorMsg = `HTTP ${status}: ${text.slice(0, 100).replace(/\n/g, ' ')}`
          failed++
          errorMap.set(errorMsg, (errorMap.get(errorMsg) || 0) + 1)
        }
      } catch (err) {
        clearTimeout(timer)
        const dt = Date.now() - t0
        errorMsg = err.name === 'AbortError' ? `Timeout (${TIMEOUT_MS}ms)` : `Exception: ${err.message}`
        failed++
        errorMap.set(errorMsg, (errorMap.get(errorMsg) || 0) + 1)
      }

      completed++
      const pct = ((completed / TOTAL_CALLS) * 100).toFixed(1)
      const successRate = ((succeeded / completed) * 100).toFixed(1)
      const avgLat = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 0

      // 实时日志（每 10 次或发生错误时打印一行）
      if (completed % 10 === 0 || !isSuccess || completed === TOTAL_CALLS) {
        const timeElapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(
          `[${completed}/${TOTAL_CALLS}] (${pct}%) | 成功: ${succeeded} 失败: ${failed} | 成功率: ${successRate}% | 平均延迟: ${avgLat}ms | 用时: ${timeElapsed}s` +
          (!isSuccess ? ` ⚠️ 错误: ${errorMsg}` : '')
        )
      }
    }
  }

  // 启动并发 worker
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1))
  await Promise.all(workers)

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
  const finalSuccessRate = ((succeeded / TOTAL_CALLS) * 100).toFixed(2)
  const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0) : 0

  console.log('\n' + '='.repeat(70))
  console.log(`📋 测试统计报告`)
  console.log('='.repeat(70))
  console.log(`总请求次数:     ${TOTAL_CALLS}`)
  console.log(`成功次数:       ${succeeded}`)
  console.log(`失败次数:       ${failed}`)
  console.log(`综合成功率:     ${finalSuccessRate}%`)
  console.log(`总消耗时间:     ${totalTime} 秒 (QPS: ${(TOTAL_CALLS / parseFloat(totalTime)).toFixed(2)})`)
  console.log(`平均响应延迟:   ${avgLatency} ms`)
  if (latencies.length > 0) {
    console.log(`P50 延迟:       ${percentile(latencies, 50)} ms`)
    console.log(`P90 延迟:       ${percentile(latencies, 90)} ms`)
    console.log(`P95 延迟:       ${percentile(latencies, 95)} ms`)
    console.log(`P99 延迟:       ${percentile(latencies, 99)} ms`)
    console.log(`最小/最大延迟:  ${Math.min(...latencies)} ms / ${Math.max(...latencies)} ms`)
  }

  if (errorMap.size > 0) {
    console.log('\n❌ 错误类型汇总:')
    for (const [msg, count] of errorMap.entries()) {
      console.log(`  - [${count}次] ${msg}`)
    }
  } else {
    console.log('\n✨ 无任何调用错误，500 次测试全部稳定通过！')
  }
  console.log('='.repeat(70) + '\n')
}

runTest().catch((e) => {
  console.error('Test runner fatal error:', e)
  process.exit(1)
})
