"""Launch engine and watchdog as separate supervised OS processes."""
import argparse,subprocess,sys,time,signal
from pathlib import Path
from common import load

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--config',default='config.toml')
    a=p.parse_args()
    config=str(Path(a.config).resolve())
    load(config)
    root=Path(__file__).resolve().parent
    stopping=False
    def stop(*_):
        global stopping
        stopping=True
    signal.signal(signal.SIGINT,stop)
    signal.signal(signal.SIGTERM,stop)
    children={}
    def launch(name):
        return subprocess.Popen([sys.executable,str(root/(name+'.py')),'--config',config],cwd=root)
    try:
        children['watchdog']=launch('watchdog')
        children['engine']=launch('engine')
        while not stopping:
            for name,child in list(children.items()):
                if child.poll() is not None:
                    print(name,'exited',child.returncode,'restarting; restart with exposure halts trading',flush=True)
                    children[name]=launch(name)
            time.sleep(5)
    finally:
        # Keep watchdog alive during engine shutdown/flatten retries.
        if 'engine' in children:
            children['engine'].terminate()
            try: children['engine'].wait(timeout=120)
            except subprocess.TimeoutExpired: children['engine'].kill()
        if 'watchdog' in children:
            children['watchdog'].terminate()
            children['watchdog'].wait(timeout=30)
