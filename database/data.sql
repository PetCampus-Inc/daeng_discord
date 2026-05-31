--
-- PostgreSQL database dump
--


-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: announcements; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.announcements VALUES (1, 'test', true, '2026-02-24 01:36:50.940995');


--
-- Data for Name: announcement_reads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ideas; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: idea_likes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memos; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: polls; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: visits; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.visits VALUES (1, '2026-02-01', 'v_fgx2zuevk', '2026-02-01 13:21:43.787602');
INSERT INTO public.visits VALUES (2, '2026-02-01', 'v_bokfo72xg', '2026-02-01 13:32:04.83555');
INSERT INTO public.visits VALUES (3, '2026-02-01', 'v_crq977k3j', '2026-02-01 13:41:48.322257');
INSERT INTO public.visits VALUES (4, '2026-02-01', 'v_lih12mjvw', '2026-02-01 13:41:58.255719');
INSERT INTO public.visits VALUES (12, '2026-02-02', 'v_crq977k3j', '2026-02-02 01:38:57.492095');
INSERT INTO public.visits VALUES (14, '2026-02-02', 'v_zc52u018a', '2026-02-02 01:43:08.543431');
INSERT INTO public.visits VALUES (22, '2026-02-03', 'v_crq977k3j', '2026-02-03 04:24:14.93501');
INSERT INTO public.visits VALUES (29, '2026-02-03', 'v_jpwdrp2aw', '2026-02-03 09:50:06.8306');
INSERT INTO public.visits VALUES (46, '2026-02-04', 'v_crq977k3j', '2026-02-04 02:38:27.507141');
INSERT INTO public.visits VALUES (57, '2026-02-04', 'v_sfd3gq83w', '2026-02-04 04:24:31.142857');
INSERT INTO public.visits VALUES (66, '2026-02-05', 'v_crq977k3j', '2026-02-05 01:45:48.837738');
INSERT INTO public.visits VALUES (73, '2026-02-05', 'v_ipj4fq8zt', '2026-02-05 08:43:02.198996');
INSERT INTO public.visits VALUES (75, '2026-02-06', 'v_crq977k3j', '2026-02-06 02:00:23.846676');
INSERT INTO public.visits VALUES (78, '2026-02-08', 'v_crq977k3j', '2026-02-08 10:41:45.757592');
INSERT INTO public.visits VALUES (80, '2026-02-09', 'v_crq977k3j', '2026-02-09 01:34:49.862367');
INSERT INTO public.visits VALUES (83, '2026-02-24', 'v_crq977k3j', '2026-02-24 00:58:55.219019');
INSERT INTO public.visits VALUES (85, '2026-02-24', 'v_tuyuk3nvz', '2026-02-24 01:02:37.601164');
INSERT INTO public.visits VALUES (88, '2026-02-24', 'v_2au4gbco2', '2026-02-24 01:39:19.656477');
INSERT INTO public.visits VALUES (92, '2026-02-26', 'v_crq977k3j', '2026-02-26 08:20:04.667714');
INSERT INTO public.visits VALUES (93, '2026-02-27', 'v_crq977k3j', '2026-02-27 01:58:10.676974');
INSERT INTO public.visits VALUES (98, '2026-03-02', 'v_crq977k3j', '2026-03-02 04:13:51.036289');
INSERT INTO public.visits VALUES (99, '2026-05-31', 'v_crq977k3j', '2026-05-31 07:02:47.313023');


--
-- Data for Name: votes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: announcement_reads_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.announcement_reads_id_seq', 1, false);


--
-- Name: announcements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.announcements_id_seq', 1, true);


--
-- Name: idea_likes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.idea_likes_id_seq', 1, false);


--
-- Name: ideas_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ideas_id_seq', 1, false);


--
-- Name: memos_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.memos_id_seq', 1, false);


--
-- Name: polls_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.polls_id_seq', 1, false);


--
-- Name: visits_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.visits_id_seq', 100, true);


--
-- Name: votes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.votes_id_seq', 1, false);


--
-- PostgreSQL database dump complete
--


