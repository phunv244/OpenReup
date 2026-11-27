"""Pipeline lồng tiếng của OpenReup (Python). Server gọi các script qua hằng số PY_SCRIPTS trong server/config.mjs.

Script chạy trực tiếp:  dub_video.py (điều phối cả quy trình), asr.py (mô hình nhận diện),
                         voice_tool.py (clone / nghe thử giọng), subtitles.py (xem trước phụ đề).
Module theo bước:       stt → translate → speakers/tts → mix → render; dùng chung: paths, common, store, job.
"""
