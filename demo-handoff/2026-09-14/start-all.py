from pathlib import Path
import subprocess,sys,webbrowser,time
root=Path(__file__).resolve().parent
children=[]
try:
 for i in [1,2,3]:children.append(subprocess.Popen([sys.executable,str(root/'serve.py'),'--demo',str(i)]))
 time.sleep(1)
 if any(p.poll() is not None for p in children):raise RuntimeError('某个端口已占用或服务启动失败，请检查上方输出。')
 for i in [1,2,3]:webbrowser.open(f'http://127.0.0.1:{8780+i}/')
 print('三个 Demo 已打开；按 Ctrl+C 停止。')
 while all(p.poll() is None for p in children):time.sleep(1)
except KeyboardInterrupt:pass
finally:
 for p in children:
  if p.poll() is None:p.terminate()
 for p in children:p.wait()
