"""Keep every finalized ASR sentence check separate from cancellable doctor replies."""
import asyncio
import contextlib


class LiveMedicalChecks:
    def __init__(self, client, record, verifier):
        self.client, self.record, self.verifier = client, record, verifier
        self.queue = asyncio.Queue(maxsize=32)
        self.rows = {}
        self.worker = None
        self.closed = False
        record.data['medical_checks'] = []

    def observe(self, message_id, text, final):
        if self.closed:
            return
        old = self.rows.get(message_id)
        if old and old['text'] == text and old.get('final') == final:
            return
        row = {'message_id':message_id, 'text':text, 'status':'checking', 'statements':[], 'preliminary':True, 'final':final}
        self.rows[message_id] = row
        self.record.data['medical_checks'] = list(self.rows.values())
        if not final:
            return
        try:
            self.queue.put_nowait(row)
        except asyncio.QueueFull:
            row.update(status='unavailable',reason='核验队列已满，本句尚未核实，不能视为准确。')
            return
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self.run())

    async def publish(self, row):
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.client.send_json({'type':'medical_check','check':{key:value for key,value in row.items() if key!='usage'}}),2)

    async def run(self):
        while True:
            row = await self.queue.get()
            try:
                if self.rows.get(row['message_id']) is not row:
                    continue
                await self.publish(row)
                context = '\n'.join(message['text'] for message in self.record.data['messages'][-8:])
                result = await self.verifier.check(row['text'],context)
                usage = result.pop('usage',None)
                if usage:
                    self.record.data['usage'].append(usage)
                # ASR corrections invalidate in-flight judgments before they can be shown or saved.
                if self.rows.get(row['message_id']) is not row:
                    continue
                row.update(result)
                await self.publish(row)
            except asyncio.CancelledError:
                raise
            except Exception:
                row.update(status='unavailable',reason='核验未完成，不能据此认定原话准确。',statements=[])
                if self.rows.get(row['message_id']) is row:
                    await self.publish(row)
            finally:
                self.queue.task_done()

    async def finish(self):
        try:
            await asyncio.wait_for(self.queue.join(),18)
        except TimeoutError:
            pass
        finally:
            self.closed = True
            if self.worker:
                self.worker.cancel()
                await asyncio.gather(self.worker,return_exceptions=True)
            for row in self.rows.values():
                if row['status']=='checking':
                    row.update(status='unavailable',reason='结束时本句核验尚未完成，需进一步核实。',statements=[])
