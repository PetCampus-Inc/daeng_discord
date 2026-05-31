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


