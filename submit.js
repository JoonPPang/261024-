/**
 * submit.js — 퀴즈 챔피언 상태 관리, 채점, 응답 기록 및 선택적 제출 모듈
 * 
 * [교사용 안내]
 * 1. Google Apps Script 웹 앱 URL(…/exec)을 SUBMISSION_ENDPOINT에 입력하면
 *    학생들의 퀴즈 결과(반, 번호, 점수, 정답률 등)를 스프레드시트에 자동 수집할 수 있습니다.
 * 2. URL이 빈 문자열('')인 기본 상태에서는 어떠한 외부 네트워크 전송도 시도하지 않습니다.
 * 3. 실제 학교 현장에서 학생 데이터를 외부로 전송·수집하기 전, 학교의 개인정보 처리 지침에 따라
 *    수집 목적, 적법한 근거, 열람 권한, 보유 기간 및 파기 방식을 반드시 검토하시기 바랍니다.
 */

const SUBMISSION_ENDPOINT = 'https://script.google.com/macros/s/AKfycbx8FweDa4XpPMV5bnhByBg5et8bHw0qi6gTKUYnlGNztIRnMB4ML5WUaOKcFPh5u1y3gw/exec';

(function (window) {
  'use strict';

  /**
   * 학생 반/번호 유효성 검증 (1~99 사이의 정수만 허용)
   * 이름은 요청하거나 수집하지 않음
   * @param {any} classVal 
   * @param {any} numVal 
   * @returns {{ valid: boolean, classNum: number|null, studentNum: number|null, errors: { class?: string, number?: string } }}
   */
  function validateStudentInfo(classVal, numVal) {
    const errors = {};
    let classNum = null;
    let studentNum = null;

    // 반 검증
    const classStr = String(classVal ?? '').trim();
    if (!classStr) {
      errors.class = '반을 입력해 주세요 (1~99).';
    } else if (!/^\d+$/.test(classStr)) {
      errors.class = '반은 숫자만 입력할 수 있어요.';
    } else {
      const parsed = parseInt(classStr, 10);
      if (parsed < 1 || parsed > 99) {
        errors.class = '반은 1~99 사이의 숫자로 입력해 주세요.';
      } else {
        classNum = parsed;
      }
    }

    // 번호 검증
    const numStr = String(numVal ?? '').trim();
    if (!numStr) {
      errors.number = '번호를 입력해 주세요 (1~99).';
    } else if (!/^\d+$/.test(numStr)) {
      errors.number = '번호는 숫자만 입력할 수 있어요.';
    } else {
      const parsed = parseInt(numStr, 10);
      if (parsed < 1 || parsed > 99) {
        errors.number = '번호는 1~99 사이의 숫자로 입력해 주세요.';
      } else {
        studentNum = parsed;
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      classNum,
      studentNum,
      errors
    };
  }

  /**
   * 누적 정답 수에 따른 레벨 계산
   * 0~2개: Lv.1, 3~5개: Lv.2, 6~8개: Lv.3, 9개 이상: Lv.4
   * @param {number} correctCount 
   * @returns {number} 1 | 2 | 3 | 4
   */
  function calculateLevel(correctCount) {
    if (correctCount >= 9) return 4;
    if (correctCount >= 6) return 3;
    if (correctCount >= 3) return 2;
    return 1;
  }

  /**
   * 정답률에 따른 최종 챔피언 등급 계산
   * 0~39%: 도전자, 40~59%: 성장 중, 60~79%: 실버, 80~99%: 골드, 100%: 챔피언
   * @param {number} accuracy 0~100 정수
   * @returns {string}
   */
  function calculateGrade(accuracy) {
    if (accuracy >= 100) return '챔피언';
    if (accuracy >= 80) return '골드';
    if (accuracy >= 60) return '실버';
    if (accuracy >= 40) return '성장 중';
    return '도전자';
  }

  /**
   * 퀴즈 엔진 상태 객체 생성
   */
  class QuizSession {
    constructor() {
      this.reset();
    }

    reset() {
      this.classNumber = null;
      this.studentNumber = null;
      this.currentQuestionIndex = 0;
      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.answers = []; // { questionId, selectedIndex, isCorrect }
      this.isAnswerLocked = false;
      this.hasSubmitted = false;
    }

    setStudent(classNum, studentNum) {
      const validation = validateStudentInfo(classNum, studentNum);
      if (!validation.valid) {
        throw new Error('유효하지 않은 반/번호입니다.');
      }
      this.classNumber = validation.classNum;
      this.studentNumber = validation.studentNum;
      return true;
    }

    getStudentTag() {
      if (this.classNumber && this.studentNumber) {
        return `${this.classNumber}반 ${this.studentNumber}번`;
      }
      return '';
    }

    getCorrectCount() {
      return this.answers.filter(a => a.isCorrect).length;
    }

    getCurrentLevel() {
      return calculateLevel(this.getCorrectCount());
    }

    /**
     * 답변 제출 및 채점
     * @param {number} selectedIndex 
     * @returns {{ isCorrect: boolean, earnedScore: number, bonusScore: number, currentCombo: number, newScore: number, level: number }}
     */
    recordAnswer(selectedIndex) {
      if (this.isAnswerLocked) {
        return null;
      }
      this.isAnswerLocked = true;

      const questions = (window.QUIZ_DATA && window.QUIZ_DATA.questions) || [];
      const question = questions[this.currentQuestionIndex];
      if (!question) {
        throw new Error('현재 문항 정보를 찾을 수 없습니다.');
      }

      const isCorrect = (selectedIndex === question.answer);
      let earnedScore = 0;
      let bonusScore = 0;

      if (isCorrect) {
        this.combo += 1;
        if (this.combo > this.maxCombo) {
          this.maxCombo = this.combo;
        }

        const baseScore = 100;
        // 2연속 정답부터 min(현재 콤보, 5) * 20 보너스 점수
        if (this.combo >= 2) {
          bonusScore = Math.min(this.combo, 5) * 20;
        }
        earnedScore = baseScore + bonusScore;
        this.score += earnedScore;
      } else {
        this.combo = 0;
      }

      this.answers.push({
        questionId: question.id,
        selectedIndex: selectedIndex,
        isCorrect: isCorrect
      });

      return {
        isCorrect,
        earnedScore,
        bonusScore,
        currentCombo: this.combo,
        newScore: this.score,
        level: this.getCurrentLevel()
      };
    }

    /**
     * 7장 제출 데이터 규격에 맞는 객체 생성
     * 필드명 및 형식 일치: quizTitle, classNumber, studentNumber, score, correctCount, totalQuestions, accuracy, maxCombo, grade, answers
     */
    buildSubmissionPayload() {
      if (!this.classNumber || !this.studentNumber) {
        throw new Error('반과 번호가 유효하지 않아 제출 페이로드를 생성할 수 없습니다.');
      }

      const questions = (window.QUIZ_DATA && window.QUIZ_DATA.questions) || [];
      const totalQuestions = questions.length;
      const correctCount = this.getCorrectCount();
      const accuracy = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
      const grade = calculateGrade(accuracy);
      const title = (window.QUIZ_DATA && window.QUIZ_DATA.title) || '퀴즈 챔피언';

      return {
        quizTitle: title,
        classNumber: this.classNumber,
        studentNumber: this.studentNumber,
        score: this.score,
        correctCount: correctCount,
        totalQuestions: totalQuestions,
        accuracy: accuracy,
        maxCombo: this.maxCombo,
        grade: grade,
        answers: this.answers.map(item => ({
          questionId: item.questionId,
          selectedIndex: item.selectedIndex,
          isCorrect: Boolean(item.isCorrect)
        }))
      };
    }

    /**
     * Apps Script 엔드포인트로 결과 전송
     * - SUBMISSION_ENDPOINT 가 비어 있으면 네트워크 요청 생략
     * - 유효한 주소일 경우 결과 화면 진입 시 1회 전송
     * @param {function(string, string): void} onStatusUpdate (status: 'submitting'|'success'|'error', message: string)
     */
    async submitResults(onStatusUpdate) {
      if (!SUBMISSION_ENDPOINT || SUBMISSION_ENDPOINT.trim() === '') {
        return { skipped: true };
      }

      if (this.hasSubmitted) {
        return { alreadySubmitted: true };
      }

      let payload;
      try {
        payload = this.buildSubmissionPayload();
      } catch (err) {
        if (typeof onStatusUpdate === 'function') {
          onStatusUpdate('error', '기록하지 못했어요. 선생님께 알려 주세요');
        }
        return { error: err.message };
      }

      this.hasSubmitted = true;
      if (typeof onStatusUpdate === 'function') {
        onStatusUpdate('submitting', '기록 중…');
      }

      try {
        const response = await fetch(SUBMISSION_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data && data.ok === true) {
          if (typeof onStatusUpdate === 'function') {
            onStatusUpdate('success', '기록 완료');
          }
          return { success: true };
        } else {
          if (typeof onStatusUpdate === 'function') {
            onStatusUpdate('error', '기록하지 못했어요. 선생님께 알려 주세요');
          }
          return { success: false };
        }
      } catch (error) {
        if (typeof onStatusUpdate === 'function') {
          onStatusUpdate('error', '기록하지 못했어요. 선생님께 알려 주세요');
        }
        return { error: error.message };
      }
    }
  }

  // 전역 노출
  window.QuizSession = QuizSession;
  window.validateStudentInfo = validateStudentInfo;
  window.calculateLevel = calculateLevel;
  window.calculateGrade = calculateGrade;
  window.SUBMISSION_ENDPOINT = SUBMISSION_ENDPOINT;

})(window);
