# Reference extraction of fixtures/SHR_KMC360i (Central Kitchen "Daily Time Record", July 2026), transcribed by
# reading the scanned pages. Used to test the Daily-Time-Record path and as a comparison for the AI's own reading.
import json, re, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = [  # (employee_no, name, dept, handwritten total, notes, printed totals, "code:days ...")  everything else = W
 ('CV0141', 'Muhammad Izhar Bin Othman', 'ADMIN', '31', 'Employee No. printed "CVCK0", CV0141 written by hand', 'Rest Day 8, Leave 0, Day Work 22, Absences 1, Lates 0', 'OFF:4,5,9,10,18,19,25,26 PH:29'),
 ('CV0131', 'MOHAMAD FAZRIEZAL BIN MAT ISA', 'DRIVER', '-1', '', 'Rest Day 10, Leave 0, Day Work 17, Absences 4, Lates 0', 'OFF:1,5,6,12,13,17,18,26,27,31 AL:14,15,16 MC:29'),
 ('CV0014', 'SHUM SUIT LI', 'ADMIN', '31', '', 'Rest Day 9, Leave 0, Day Work 21, Absences 1, Lates 0', 'PH:1 OFF:2,3,11,12,16,17,23,24,30'),
 ('CV0013', 'SELVAN A/L MALAYALAM', 'DRIVER', '-2', '', 'Rest Day 8, Leave 0, Day Work 19, Absences 4, Lates 0', 'PL:1,2 OFF:3,4,10,11,19,20,24,25 MC:28,29'),
 ('CV0012', 'NOR SHAHIZAN BINTI SEPUAN', 'ADMIN', '', '', 'Rest Day 10, Leave 0, Day Work 20, Absences 1, Lates 0', 'OFF:2,3,11,12,16,17,25,26,30,31 TRN:20,21 PH:27'),
 ('CV0006', 'LEE MUN YAN', 'ADMIN', '31', '', 'Rest Day 8, Leave 0, Day Work 23, Absences 0, Lates 0', 'OFF:4,5,9,10,18,19,24,28 TRN:20,21'),
 ('CV0004', 'ISHAK BIN JUNOS', 'DRIVER', '-2', '', 'Rest Day 9, Leave 0, Day Work 20, Absences 2, Lates 0', 'OFF:3,4,12,13,17,18,26,27,31 MC:8,9'),
 ('CV0002', 'ABDUL SAMAD BIN IDRIS', 'DRIVER', '31', '', 'Rest Day 8, Leave 0, Day Work 22, Absences 1, Lates 0', 'OFF:5,6,10,11,19,20,24,25 AL:7'),
 ('', 'MUHAMAD RASYDAN BIN BUSTAMI', 'CHEF', '31', 'KITCHEN written at top; Employee No. blank ("...")', 'Rest Day 8, Leave 0, Day Work 23, Absences 0, Lates 0', 'OFF:3,4,5,6,17,18,24,25'),
 ('CV0011', 'Muhammad Noor Amirul Bin Md Zin', 'CHEF', '31', '', 'Rest Day 9, Leave 0, Day Work 21, Absences 1, Lates 0', 'AL:9 OFF:10,11,12,13,19,20,26,27,31'),
 ('CV0007', 'LIM SOON LEE', 'CHEF', '31', '', 'Rest Day 8, Leave 0, Day Work 22, Absences 1, Lates 0', 'OFF:5,6,10,11,19,20,24,28 PH:21'),
 ('CV0005', 'KHAW SIONG SIM', 'CHEF', '31', '', 'Rest Day 8, Leave 0, Day Work 21, Absences 2, Lates 0', 'OFF:4,5,11,12,18,19,25,26 TRN:20,21 PH:24'),
 ('CV0017', 'ZAINUDDIN BIN ABU BAKAR', 'CHEF', '31', '', 'Rest Day 9, Leave 0, Day Work 22, Absences 0, Lates 0', 'OFF:5,6,10,11,18,19,24,25,31 TRN:20,21'),
 ('CV0009', 'MOHD RAIS BIN JALIH', 'CHEF', '31', '', 'Rest Day 8, Leave 0, Day Work 23, Absences 0, Lates 0', 'OFF:5,6,10,11,19,20,24,25'),
 ('CV0010', 'MUHAMAD SAIFUL BIN KAMARUDDIN', 'CHEF', '31', '', 'Rest Day 9, Leave 0, Day Work 22, Absences 0, Lates 0', 'OFF:3,4,12,13,18,19,26,27,31'),
 ('CV0015', 'TAY RONG SHEN', 'CHEF', '31', '', 'Rest Day 9, Leave 0, Day Work 22, Absences 0, Lates 0', 'OFF:3,4,12,13,17,18,26,27,31'),
]
pages = []
for i, (eid, name, dept, tot, notes, printed, spec) in enumerate(SPEC, 1):
    days = ['W|07:00'] * 31
    for part in spec.split():
        code, ds = part.split(':')
        for d in ds.split(','): days[int(d) - 1] = code
    pages.append({'page': i, 'layout': 'daily_time_record', 'company': 'CHAMPION VISTA SDN BHD', 'period_start': '2026-07-01', 'period_end': '2026-07-31',
                  'employees': [{'employee_id': eid, 'name': name, 'department': dept, 'handwritten_total': tot, 'printed_totals': printed, 'notes': notes, 'days': days}]})
out = os.path.join(ROOT, 'fixtures/REFERENCE-central-kitchen-DTR-July2026-extraction.json')
json.dump({'file': 'SHR_KMC360i26101614240.pdf', 'note': 'Transcribed by reading the scan (punch times simplified to 07:00). For testing; verify against the PDF.', 'pages': pages}, open(out, 'w'), indent=1)
print('wrote', out, len(pages), 'pages')
