"""Process-local pacing; other apps on the same provider account have separate traffic."""
import asyncio


class RateLimit:
    def __init__(self, qps: int):
        self.interval = 1 / qps
        self.lock = asyncio.Lock()
        self.next_start = 0.0

    async def wait(self):
        async with self.lock:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(max(0, self.next_start - loop.time()))
            self.next_start = loop.time() + self.interval
