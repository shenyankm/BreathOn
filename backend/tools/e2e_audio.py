"""Generate a clearly synthetic E2E utterance with the configured real TTS provider."""
import argparse
import asyncio
from pathlib import Path
import struct

from medvisit.core.config import Settings
from medvisit.voice.tts import synthesize


def resample(pcm):
    samples = struct.unpack('<'+'h'*(len(pcm)//2), pcm)
    result = []
    for i in range(0,len(samples)-2,3):
        result.extend((samples[i],(samples[i+1]+samples[i+2])//2))
    return struct.pack('<'+'h'*len(result),*result)


async def main(path):
    if path.exists():
        raise FileExistsError("Refuse to replace an existing speech fixture")
    chunks=[]
    async def collect(pcm):
        chunks.append(pcm)
    await synthesize(Settings(),'您好，我想先了解您今天更关注什么问题，再核对原始资料的适用范围，不作个体效果保证。','local-e2e-synthetic',collect)
    result=resample(b''.join(chunks))
    assert len(result)>32000, 'No usable synthetic speech returned'
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(result)


if __name__=='__main__':
    assert resample(struct.pack('<6h',0,10,20,30,40,50))==struct.pack('<4h',0,15,30,45)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',action='store_true',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    asyncio.run(main(args.output))
