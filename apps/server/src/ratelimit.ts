/** 简单令牌桶：每连接限流 agent.invoke / upload.start */
export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity
    this.lastRefill = Date.now()
  }

  take(): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSec)
    this.lastRefill = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }
}

export function createInvokeBucket(): TokenBucket {
  return new TokenBucket(30, 0.25)
}
