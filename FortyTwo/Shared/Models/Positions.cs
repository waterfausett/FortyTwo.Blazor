namespace FortyTwo.Shared.Models
{
    public enum Positions
    {
        First = 0,
        Second = 1,
        Third = 2,
        Fourth = 3,
    }

    public static class PositionsExtensions
    {
        public static Positions NextPosition(this Positions position)
        {
            return (Positions)(((int)position + 1) % 4);
        }
    }
}
