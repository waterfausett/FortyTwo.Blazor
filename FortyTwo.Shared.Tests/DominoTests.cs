using FortyTwo.Shared.Models;
using Xunit;

namespace FortyTwo.Shared.Tests
{
    public class DominoTests
    {
        [Theory]
        [InlineData(1, 6, Suit.Aces, Suit.Aces, true)]
        [InlineData(1, 6, Suit.Sixes, Suit.Fives, true)]
        [InlineData(1, 6, Suit.Aces, Suit.Fives, true)]
        [InlineData(1, 6, Suit.Fours, Suit.Aces, false)]
        [InlineData(1, 6, Suit.Aces, Suit.Sixes, false)]
        [InlineData(1, 6, Suit.Sixes, Suit.Aces, false)]
        [InlineData(1, 6, Suit.Deuces, Suit.Fives, false)]
        [InlineData(1, 1, Suit.Deuces, Suit.Fives, false)]
        public void IsOfSuit(int top, int bottom, Suit suit, Suit trump, bool expectedResult)
        {
            // Arrange
            var domino = new Domino(top, bottom);

            // Act
            var result = domino.IsOfSuit(suit, trump);

            // Assert
            Assert.Equal(expectedResult, result);
        }

        [Theory]
        [InlineData(1, 6, Suit.Fours, Suit.Sixes)]
        [InlineData(1, 6, Suit.Sixes, Suit.Sixes)]
        [InlineData(1, 6, Suit.Aces, Suit.Aces)]
        [InlineData(1, 1, Suit.Aces, Suit.Aces)]
        [InlineData(1, 1, Suit.Deuces, Suit.Aces)]
        [InlineData(0, 0, Suit.Aces, Suit.Blanks)]
        public void GetSuit(int top, int bottom, Suit trump, Suit expectedResult)
        {
            // Arrange
            var domino = new Domino(top, bottom);

            // Act
            var result = domino.GetSuit(trump);

            // Assert
            Assert.Equal(expectedResult, result);
        }

        [Theory]
        [InlineData(1, 6, Suit.Aces, Suit.Aces, 6)]
        [InlineData(0, 0, Suit.Aces, Suit.Aces, -1)]
        [InlineData(0, 1, Suit.Aces, Suit.Aces, 0)]
        [InlineData(1, 4, Suit.Aces, Suit.Aces, 4)]
        [InlineData(1, 1, Suit.Aces, Suit.Aces, 7)]

        [InlineData(1, 1, Suit.Aces, Suit.Fours, 7)]
        [InlineData(1, 1, Suit.Deuces, Suit.Fours, -1)]
        [InlineData(1, 1, Suit.Deuces, Suit.Aces, 17)]
        public void GetSuitValue(int top, int bottom, Suit suit, Suit trump, int expectedResult)
        {
            // Arrange
            var domino = new Domino(top, bottom);

            // Act
            var result = domino.GetSuitValue(suit, trump);

            // Assert
            Assert.Equal(expectedResult, result);
        }
    }
}