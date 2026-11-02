"""Bounded passive macOS native MCP cache completion; no polling/reconnect."""
import json,re,select,time
from pathlib import Path
MAX_STARTUP_SECONDS=120

def native_log_directory(profile):
 cwd=profile['guard']['fixture'];name=re.sub(r'[^a-zA-Z0-9]','-',cwd)
 if len(name)>200:raise RuntimeError('Native cache key exceeds proven fixture contract')
 return Path(profile['os_home'])/'Library/Caches/claude-cli-nodejs'/name/'mcp-logs-tea-rags'

class VnodeChanges:
 def __init__(self):self.kq=select.kqueue();self.files={}
 def arm(self,paths):
  for path in paths:
   path=Path(path)
   if path in self.files or not path.exists():continue
   handle=path.open('rb') if path.is_file() else None
   if handle is None:
    import os
    fd=os.open(path,os.O_RDONLY);self.files[path]=(fd,None)
   else:fd=handle.fileno();self.files[path]=(fd,handle)
   self.kq.control([select.kevent(fd,filter=select.KQ_FILTER_VNODE,flags=select.KQ_EV_ADD|select.KQ_EV_CLEAR,fflags=select.KQ_NOTE_WRITE|select.KQ_NOTE_EXTEND|select.KQ_NOTE_RENAME|select.KQ_NOTE_DELETE)],0,0)
 def wait(self,deadline):
  left=deadline-time.monotonic()
  if left<=0 or not self.kq.control(None,1,left):raise TimeoutError('Native MCP startup deadline')
 def close(self):
  import os
  self.kq.close()
  for fd,handle in self.files.values():
   if handle is None:os.close(fd)
   else:handle.close()

class NativeMcpLogWait:
 def __init__(self,profile,started_at=None,max_seconds=MAX_STARTUP_SECONDS,clock=time.monotonic,changes=None):
  self.directory=native_log_directory(profile);self.directory.mkdir(parents=True,exist_ok=True);self.cwd=profile['guard']['fixture'];self.clock=clock;self.started_at=clock() if started_at is None else started_at;self.deadline=self.started_at+min(max_seconds,MAX_STARTUP_SECONDS);self.baseline=set(self.directory.glob('*.jsonl'));self.offsets={};self.buffers={};self.changes=changes
 def _scan(self,paths,session_id):
  for path in paths:
   with path.open('rb') as stream:stream.seek(self.offsets.get(path,0));chunk=stream.read();self.offsets[path]=stream.tell()
   data=self.buffers.get(path,b'')+chunk;lines=data.split(b'\n');self.buffers[path]=lines.pop()
   for line in lines:
    if not line:continue
    try:event=json.loads(line)
    except ValueError:raise RuntimeError('Malformed native MCP cache event') from None
    if event.get('sessionId')!=session_id or event.get('cwd')!=self.cwd:continue
    text=str(event.get('debug',event.get('error','')))
    success=re.fullmatch(r'Successfully connected \(transport: stdio\) in (\d+)ms',text)
    if success:return {'status':'connected','session_id':session_id,'native_connect_ms':int(success[1]),'native_log_path':str(path),'elapsed_seconds':self.clock()-self.started_at,'limitation':'Connect log precedes tool metadata; exactly one subsequent native mcp_status must be connected with17 tools, otherwise fail unserved.'}
    failure=re.match(r'Connection failed(?: after \d+ms)?(?: \(([A-Z0-9_]+)\))?:',text)
    if failure:raise RuntimeError('Native MCP terminal failure: '+(failure[1] or 'UNCLASSIFIED'))
 def wait_terminal(self,session_id):
  if not isinstance(session_id,str) or not session_id:raise RuntimeError('Current native session identity missing')
  changes=self.changes or VnodeChanges()
  try:
   while True:
    if self.clock()>=self.deadline:raise TimeoutError('Native MCP startup deadline')
    # Watch creation before enumerating, then watch append before reading.
    changes.arm([self.directory])
    paths=sorted(set(self.directory.glob('*.jsonl'))-self.baseline)
    changes.arm(paths)
    result=self._scan(paths,session_id)
    if result:return result
    changes.wait(self.deadline)
  finally:changes.close()
