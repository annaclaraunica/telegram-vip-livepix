class AsyncQueue {
  constructor({ delayMs = 900 } = {}) {
    this.delayMs = Number(delayMs) || 900
    this.current = Promise.resolve()
  }

  push(task) {
    const run = async () => {
      const result = await task()
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      }
      return result
    }
    const next = this.current.then(run, run)
    this.current = next.catch(() => {})
    return next
  }
}

module.exports = { AsyncQueue }
