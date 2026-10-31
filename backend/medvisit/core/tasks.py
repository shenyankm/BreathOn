import asyncio


async def drain(task):
    cancelled = False
    # Cancellation cannot stop a thread or release its storage guard early.
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


async def work(function, *args):
    return await drain(asyncio.create_task(asyncio.to_thread(function, *args)))
