import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
import pillow_heif


class BaselineEnteDecoderTests(unittest.TestCase):
    def test_fresh_child_reads_heic_with_frozen_module_paths_and_forwards_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = root/'runtime'
            (runtime/'tools').mkdir(parents=True)
            (runtime/'selection_marker.py').write_text('VALUE="frozen"\n')
            (runtime/'tools/prepare_marker.py').write_text('VALUE="frozen-tools"\n')
            (runtime/'tools/run_ente_lab.py').write_text(
                'import json,sys\nfrom PIL import Image\n'
                'import selection_marker,prepare_marker\n'
                'with Image.open(sys.argv[1]) as image:\n'
                ' image.load()\n'
                ' image.getexif()\n'
                ' print(json.dumps({"format":image.format,"size":image.size,'
                '"marker":selection_marker.VALUE,"tools":prepare_marker.VALUE,'
                '"args":sys.argv[2:]}))\n')
            photo = root/'synthetic.heic'
            pillow_heif.from_pillow(Image.new('RGB',(16,16),'red')).save(photo)
            shadow = root/'shadow'
            shadow.mkdir()
            (shadow/'selection_marker.py').write_text('VALUE="wrong"\n')
            script = Path(__file__).resolve().parents[1]/'tools/run_baseline_ente.py'
            result = subprocess.run([sys.executable,str(script),'--runtime',str(runtime),
                                     str(photo),'--cache-dir','isolated-cache'],
                                    env={**os.environ,'PYTHONPATH':str(shadow)},
                                    capture_output=True,text=True,check=True)
            value = json.loads(result.stdout)
            self.assertEqual(value['format'],'HEIF')
            self.assertEqual(value['size'],[16,16])
            self.assertEqual(value['marker'],'frozen')
            self.assertEqual(value['tools'],'frozen-tools')
            self.assertEqual(value['args'],['--cache-dir','isolated-cache'])


if __name__ == '__main__':
    unittest.main()
