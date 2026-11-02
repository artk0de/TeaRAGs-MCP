"""Focused native cache-event waits. No CLI/model processes."""
import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import native_mcp_wait as m
class FakeChanges:
 def __init__(self,clock,actions):self.clock=clock;self.actions=actions;self.calls=[]
 def arm(self,paths):self.paths=list(paths)
 def wait(self,deadline):
  self.calls.append(deadline)
  if not self.actions:raise TimeoutError('native wait deadline')
  action=self.actions.pop(0);action()
 def close(self):pass
class NativeWaitTests(unittest.TestCase):
 def fixture(self,d):
  p={'os_home':d,'guard':{'fixture':'/Users/Shared/nav-ab/p0-context-eval-ng1ni'}};directory=m.native_log_directory(p);directory.mkdir(parents=True);return p,directory
 def write(self,p,sid,message):p.write_text(json.dumps({'sessionId':sid,'cwd':'/Users/Shared/nav-ab/p0-context-eval-ng1ni','debug':message})+'\n')
 def test_current_process_filters_old_file_and_foreign_session_without_poll_or_sleep(self):
  with tempfile.TemporaryDirectory() as d:
   profile,logs=self.fixture(d);self.write(logs/'old.jsonl','current','Successfully connected (transport: stdio) in 1ms');clock=[0.];actions=[lambda:(self.write(logs/'foreign.jsonl','foreign','Successfully connected (transport: stdio) in 1ms'),clock.__setitem__(0,1.)),lambda:(self.write(logs/'current.jsonl','current','Successfully connected (transport: stdio) in 50000ms'),clock.__setitem__(0,2.))];events=FakeChanges(clock,actions);wait=m.NativeMcpLogWait(profile,started_at=0,clock=lambda:clock[0],changes=events)
   with patch('time.sleep',side_effect=AssertionError('must not sleep')):result=wait.wait_terminal('current')
   self.assertEqual(result['status'],'connected');self.assertEqual(result['native_connect_ms'],50000);self.assertEqual(len(events.calls),2)
 def test_failed_terminal_is_final_no_retry(self):
  with tempfile.TemporaryDirectory() as d:
   profile,logs=self.fixture(d);events=FakeChanges([0.],[]);wait=m.NativeMcpLogWait(profile,started_at=0,clock=lambda:1.,changes=events);self.write(logs/'current.jsonl','current','Connection failed after 120000ms (CONNECT_TIMEOUT): Request timed out')
   with self.assertRaisesRegex(RuntimeError,'CONNECT_TIMEOUT'):wait.wait_terminal('current')
   self.assertEqual(events.calls,[])
 def test_maxdeadline_never_resets_on_foreign_activity(self):
  with tempfile.TemporaryDirectory() as d:
   profile,logs=self.fixture(d);clock=[0.];actions=[lambda:(self.write(logs/'x.jsonl','other','Starting connection'),clock.__setitem__(0,110.)),lambda:(self.write(logs/'y.jsonl','other','Starting connection'),clock.__setitem__(0,121.))];events=FakeChanges(clock,actions);wait=m.NativeMcpLogWait(profile,started_at=0,max_seconds=999,clock=lambda:clock[0],changes=events)
   with self.assertRaises(TimeoutError):wait.wait_terminal('current')
   self.assertEqual(events.calls,[120.,120.])
 def test_partial_append_is_not_dropped(self):
  with tempfile.TemporaryDirectory() as d:
   profile,logs=self.fixture(d);clock=[0.];path=logs/'current.jsonl';line=json.dumps({'sessionId':'current','cwd':profile['guard']['fixture'],'debug':'Successfully connected (transport: stdio) in 7ms'})+'\n';events=FakeChanges(clock,[lambda:path.write_text(line)]);wait=m.NativeMcpLogWait(profile,started_at=0,clock=lambda:clock[0],changes=events);path.write_text(line[:20]);result=wait.wait_terminal('current');self.assertEqual(result['status'],'connected')
 def test_directory_armed_before_enumeration_closes_creation_race(self):
  with tempfile.TemporaryDirectory() as d:
   profile,logs=self.fixture(d);owner=self
   class CreateDuringArm(FakeChanges):
    def arm(self,paths):
     super().arm(paths)
     if not getattr(self,'created',False):owner.write(logs/'new-current.jsonl','current','Successfully connected (transport: stdio) in 4ms');self.created=True
   changes=CreateDuringArm([0.],[]);wait=m.NativeMcpLogWait(profile,started_at=0,clock=lambda:1.,changes=changes)
   result=wait.wait_terminal('current');self.assertEqual(result['status'],'connected');self.assertEqual(changes.calls,[])
 def test_only_known_empty_cache_directory_is_precreated(self):
  with tempfile.TemporaryDirectory() as d:
   profile={'os_home':str(Path(d)/'home'),'guard':{'fixture':'/Users/Shared/nav-ab/p0-context-eval-ng1ni'}};wait=m.NativeMcpLogWait(profile,started_at=0,clock=lambda:0.,changes=FakeChanges([0.],[]))
   self.assertTrue(wait.directory.is_dir());self.assertEqual(list(wait.directory.iterdir()),[]);self.assertFalse((Path(profile['os_home'])/'.claude').exists());self.assertFalse((Path(profile['os_home'])/'.claude.json').exists())
if __name__=='__main__':unittest.main()
